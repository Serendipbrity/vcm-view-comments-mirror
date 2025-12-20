const { buildContextKey } = require("../buildContextKey");

// ============================================================================
// syncCommentsToVCMs() determines:
// ============================================================================
// what’s in the editor right now (docComments)
// what’s in the VCM JSON (vcmComments)
// what’s in the other VCM file (otherVCMComments: shared vs private)

// It decides how to:
// preserve metadata (alwaysShow, anchors, etc.)
// avoid shared/private cross-contamination
// track clean-mode edits via text_cleanMode
// update private comments correctly in clean mode
// It Returns: “here are the updated comments that should be saved back into this VCM”.
// ============================================================================
function syncCommentsToVCMs({
  isCommented, // boolean: true = commented mode, false = clean mode
  docComments, // array: comments extracted from current document
  vcmComments, // array: comments from current VCM file (will be modified in place for clean mode)
  otherVCMComments = [], // array: comments from other VCM (to detect cross-contamination)
  isPrivateMode = false, // boolean: true = processing private comments, false = shared
  wasJustInjected = false, // boolean: skip processing in clean mode if just injected
}) {


  // If we are in clean mode and wasJustInjected is true → bail out, return vcmComments unchanged. 
  // That prevents the “I just injected from VCM and now I think these are new clean-mode edits” bug.
  if (!isCommented && wasJustInjected) {
    return vcmComments;
  }

  let finalComments;

  // ========================================================================
  // COMMENTED MODE: Replace VCM with current state, preserving metadata
  // ========================================================================
  // In commented mode, the source of truth is the document, not the VCM.
  if (isCommented) {
    // ---------------------- Current VCM Comments (Shared or Private VCM) -----------------------------------------
    // Build map of current vcm comments by anchor for the current vcm (shared or private depending on which file we are syncing rn)
    const vcmComByKEY = new Map(); // context key catches same location, even if identical text occurs elsewhere.
    const vcmComByTEXT = new Map(); // text mapping catches same comment if its anchor changed (code moved).
    for (const comment of vcmComments) { // loop over vcm comments
      // build key for each vcm comment
      // This is what lets us say “this vcm comment corresponds to that current comment in the doc.”
      const key = buildContextKey(comment); 
      if (!vcmComByKEY.has(key)) { // If this context key hasn’t been seen yet:
        // Initialize it to an empty array. because multiple comments could share the same key. like duplicating comments through the file
        // We treat it as a queue of candidates instead of assuming 1-to-1.
        vcmComByKEY.set(key, []); 
      }
      // Append this vcm comment to the array for that context key.
      // vcmComByKEY looks like: "inline:abc123:def456:ghi789" -> [comment1, comment2, ...]
      vcmComByKEY.get(key).push(comment);

      // This builds a text fingerprint for fallback matching.
      // If anchors change (code moved, refactored), the hashes might not match anymore, but the comment text still does. 
      // So we can use textKey as a secondary match.
      const textKey =
        // If it’s an inline comment: comment.text is the actual comment string. Use that.
        // comment.text = vcmObject.text = inline comment
        comment.text ||
        // If it’s a block comment: join all the block parts into one string for matching else ignore it if not present.
        (comment.block ? comment.block.map((b) => b.text).join("\n") : "");
      // if we got a textKey and it’s not already in the map:
      if (textKey && !vcmComByTEXT.has(textKey)) {
        vcmComByTEXT.set(textKey, comment); // Map the textKey to this vcm comment.
      }
    }
    // ---------------------- Other VCM Comments -----------------------------------------
    // This section is the same as above but for the "other" VCM comments
    // If we’re syncing shared, otherVCMComments = private comments.
    // If we’re syncing private, otherVCMComments = shared comments.
    const otherByKey = new Map();
    const otherByText = new Map();

    for (const otherComment of otherVCMComments) {
      const key = buildContextKey(otherComment);
      if (!otherByKey.has(key)) {
        otherByKey.set(key, []);
      }
      otherByKey.get(key).push(otherComment);

      // Index by text
      const textKey =
        otherComment.text ||
        (otherComment.block
          ? otherComment.block.map((b) => b.text).join("\n")
          : "");
      if (textKey && !otherByText.has(textKey)) {
        otherByText.set(textKey, otherComment);
      }
    } // ---------------------------------------------------------------
    const matchedVCMComments = new Set(); // Track which current vcm comments we've matched
    const matchedOtherVCMComments = new Set(); // Track which of the other vcm comments we've matched

    // claimMatch ensures we don’t accidentally treat a single otherComment vcm object as multiple separate matches in one pass.
    const claimMatch = (map, key) => {
      const candidates = map.get(key); // Fetch all “other” comments with that context key.
      if (!candidates) return null; // If none found, return null.

      // Normalize to array so we can safely search
      const candidateList = Array.isArray(candidates) ? candidates : [candidates];
      // Pick the first one that hasn’t been used yet. matchedOtherVCMComments is a Set of “other comments we already matched”.
      const candidate = candidateList.find((c) => !matchedOtherVCMComments.has(c));
      if (!candidate) return null;
      matchedOtherVCMComments.add(candidate); // Mark this one as claimed
      const remaining = candidateList.filter((c) => c !== candidate); // remove it from the map
      if (remaining.length > 0) {
        map.set(key, remaining);
      } else {
        map.delete(key); // remove it from the map
      }
      return candidate;
    };

    // Process current doc comments and match with current vcm (shared or private) to preserve metadata
    finalComments = docComments.map((current) => {
      const key = buildContextKey(current);
      const currentText =
        current.text ||
        (current.block ? current.block.map((b) => b.text).join("\n") : "");

      // Check if this comment exists in the "other" VCM (cross-contamination detection)
      const otherMatch = claimMatch(otherByKey, key);
      if (otherMatch) {
        // This comment belongs to the other VCM - mark it appropriately
        return {
          ...current,
          isPrivate: !isPrivateMode, // If processing shared, mark as private; if processing private, don't mark
        };
      }

      // Also check by text in case anchor changed
      if (currentText && otherByText.has(currentText)) {
        const otherMatchByText = claimMatch(otherByText, currentText);
        if (otherMatchByText) {
          return {
            ...current,
            isPrivate: !isPrivateMode,
          };
        }
      }

      // Not from other VCM - check this VCM's existing comments for metadata
      const candidates = vcmComByKEY.get(key) || [];
      if (candidates.length > 0) {
        // Found match by anchor - preserve metadata
        const existing = candidates[0];
        matchedVCMComments.add(existing);
        candidates.shift();
        if (candidates.length === 0) {
          vcmComByKEY.delete(key);
        }

        return {
          ...current,
          alwaysShow: existing.alwaysShow || undefined,
          // Preserve any other metadata fields here
        };
      }

      // No match by anchor - try matching by text (anchor might have changed)
      if (currentText && vcmComByTEXT.has(currentText)) {
        const existing = vcmComByTEXT.get(currentText);
        if (!matchedVCMComments.has(existing)) {
          matchedVCMComments.add(existing);
          return {
            ...current,
            alwaysShow: existing.alwaysShow || undefined,
          };
        }
      }

      // No match found - return as-is (new comment)
      return current;
    });

    // In commented mode, DO NOT add back unmatched existing comments
    // If a comment isn't in the current document, it was deleted
  } else {
    // ========================================================================
    // CLEAN MODE: Preserve hidden shared VCM comments, track new ones via text_cleanMode (shared) or direct update (private)
    //  source of truth are vcm's
    // # TODO text_cleanMode should be able to be marked always show or private and removed from shared and added to private 
    // ========================================================================

    // Build map of the current vcm's comments by anchor + context hashes
    const vcmComByKEY = new Map();
    for (const comment of vcmComments) {
      const key = buildContextKey(comment);
      if (!vcmComByKEY.has(key)) {
        vcmComByKEY.set(key, []);
      }
      vcmComByKEY.get(key).push(comment);
    }

    // Build set of "other" comment keys for filtering
    const otherKeys = new Set();
    const otherTexts = new Set();
    for (const otherComment of otherVCMComments) {
      const key = buildContextKey(otherComment);
      otherKeys.add(key);

      const textKey =
        otherComment.text ||
        (otherComment.block
          ? otherComment.block.map((b) => b.text).join("\n")
          : "");
      if (textKey) {
        otherTexts.add(`${otherComment.type}:${textKey}`);
      }
    }

    if (isPrivateMode) {
      // ====================================================================
      // PRIVATE MODE IN CLEAN: Update anchors by matching text (like shared)
      // ====================================================================

      // Build map by text for matching
      const vcmComByTEXT = new Map();
      for (const existing of vcmComments) {
        const textKey =
          existing.text ||
          (existing.block ? existing.block.map((b) => b.text).join("\n") : "");
        if (textKey && !vcmComByTEXT.has(textKey)) {
          vcmComByTEXT.set(textKey, existing);
        }
      }

      // Track which existing comments we've matched
      const matchedVCMComments = new Set();

      // Process current comments
      for (const current of docComments) {
        const key = buildContextKey(current);
        const currentText =
          current.text ||
          (current.block ? current.block.map((b) => b.text).join("\n") : "");

        // Skip if this comment belongs to the "other" VCM (shared)
        if (otherKeys.has(key)) {
          continue;
        }

        // Match by text first (handles when comment moves)
        let existing = null;
        if (currentText && vcmComByTEXT.has(currentText)) {
          const candidate = vcmComByTEXT.get(currentText);
          if (!matchedVCMComments.has(candidate)) {
            existing = candidate;
            matchedVCMComments.add(existing);
            // Update anchor to new position
            existing.anchor = current.anchor;
            existing.prevHash = current.prevHash;
            existing.nextHash = current.nextHash;
            existing.commentedLineIndex = current.commentedLineIndex;
            // Update content
            existing.text = current.text;
            existing.block = current.block;
            // Update anchorText
            if (current.anchorText !== undefined) {
              existing.anchorText = current.anchorText;
            }
          }
        }

        // If no text match, try anchor match
        if (!existing) {
          const candidates = vcmComByKEY.get(key) || [];
          if (candidates.length > 0 && !matchedVCMComments.has(candidates[0])) {
            existing = candidates[0];
            matchedVCMComments.add(existing);
            // Update content
            existing.text = current.text;
            existing.block = current.block;
            if (current.anchorText !== undefined) {
              existing.anchorText = current.anchorText;
            }
          }
        }

        // If still no match, add as new
        if (!existing) {
          vcmComments.push(current);
          matchedVCMComments.add(current);
        }
      }

      // Return all existing comments (updated in place)
      finalComments = vcmComments;
    } else {
      // ====================================================================
      // SHARED MODE IN CLEAN: Track changes via text_cleanMode
      // ====================================================================

      // Build map by text_cleanMode content for matching
      const vcmComByTEXTCleanMode = new Map();
      for (const existing of vcmComments) {
        if (existing.text_cleanMode) {
          const textKey =
            typeof existing.text_cleanMode === "string"
              ? existing.text_cleanMode
              : Array.isArray(existing.text_cleanMode)
              ? existing.text_cleanMode.map((b) => b.text).join("\n")
              : "";
          if (textKey && !vcmComByTEXTCleanMode.has(textKey)) {
            vcmComByTEXTCleanMode.set(textKey, existing);
          }
        }
      }

      // Track which existing comments we've matched
      const matchedInCleanMode = new Set();

      // Process current comments (typed in clean mode)
      for (const current of docComments) {
        const key = buildContextKey(current);
        const currentText =
          current.text ||
          (current.block ? current.block.map((b) => b.text).join("\n") : "");
        const textKey = `${current.type}:${currentText}`;

        // Skip if this comment belongs to the "other" VCM
        if (otherKeys.has(key) || otherTexts.has(textKey)) {
          continue;
        }

        // Also check by text in case anchor changed
        // BUT: Only skip if this text matches other comment AND doesn't match any existing comment
        const isOtherCommentText = otherTexts.has(textKey);
        const isExistingCommentText =
          vcmComByTEXTCleanMode.has(currentText) ||
          vcmComments.some((ec) => {
            const ecText = ec.text || "";
            return ecText === currentText;
          });

        if (isOtherCommentText && !isExistingCommentText) {
          // This text only exists in other VCM, not in this one - skip it
          continue;
        }

        // Process as a comment for this VCM
        let existing = null;

        // First, try to match by text_cleanMode content (handles anchor changes)
        if (currentText && vcmComByTEXTCleanMode.has(currentText)) {
          const candidate = vcmComByTEXTCleanMode.get(currentText);
          if (!matchedInCleanMode.has(candidate)) {
            existing = candidate;
            matchedInCleanMode.add(existing);
            // Update anchor to new position (comment moved with code)
            existing.anchor = current.anchor;
            existing.prevHash = current.prevHash;
            existing.nextHash = current.nextHash;
          }
        }

        // If no text match, try anchor match (for VCM comments)
        if (!existing) {
          const candidates = vcmComByKEY.get(key) || [];
          if (candidates.length > 0 && !matchedInCleanMode.has(candidates[0])) {
            existing = candidates[0];
            matchedInCleanMode.add(existing);
          }
        }

        if (existing) {
          // Update text_cleanMode
          if (current.type === "inline") {
            if (current.text !== existing.text) {
              existing.text_cleanMode = current.text;
            } else {
              existing.text_cleanMode = null;
            }
          } else if (current.type === "block") {
            const existingTexts =
              existing.block?.map((b) => b.text).join("\n") || "";
            const currentTexts =
              current.block?.map((b) => b.text).join("\n") || "";
            const blocksIdentical = existingTexts === currentTexts;

            if (!blocksIdentical) {
              existing.text_cleanMode = current.block;
            } else {
              existing.text_cleanMode = null;
            }
          }
        } else {
          // No match - this is a newly typed comment in clean mode
          const newComment = { ...current };
          if (current.type === "inline") {
            newComment.text_cleanMode = current.text;
            delete newComment.text;
          } else if (current.type === "block") {
            newComment.text_cleanMode = current.block;
            delete newComment.block;
          }
          vcmComments.push(newComment);
          matchedInCleanMode.add(newComment);
        }
      }

      // Remove text_cleanMode from comments that were deleted in clean mode
      for (const existing of vcmComments) {
        if (existing.text_cleanMode) {
          const key = `${existing.type}:${existing.anchor}`;
          const stillExists = docComments.some(
            (c) => `${c.type}:${c.anchor}` === key
          );

          if (!stillExists) {
            // User deleted this comment in clean mode
            existing.text_cleanMode = null;
          }
        }
      }

      finalComments = vcmComments;
    }
  }

  return finalComments;
}

module.exports = {
  syncCommentsToVCMs,
  buildContextKey,
};
