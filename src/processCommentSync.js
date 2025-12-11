function buildContextKey(comment) {
  return `${comment.type}:${comment.anchor}:${comment.prevHash || "null"}:${
    comment.nextHash || "null"
  }`;
}

// ============================================================================
// processCommentSync()
// ============================================================================
// Reusable function for processing comment synchronization in both commented
// and clean modes. Handles matching, deduplication, and property updates.
// Used for both shared and private comments to eliminate code duplication.
// ============================================================================
function processCommentSync({
  isCommented, // boolean: true = commented mode, false = clean mode
  currentComments, // array: comments extracted from current document
  existingComments, // array: comments from VCM file (will be modified in place for clean mode)
  otherComments = [], // array: comments from other VCM (to detect cross-contamination)
  isPrivateMode = false, // boolean: true = processing private comments, false = shared
  wasJustInjected = false, // boolean: skip processing in clean mode if just injected
}) {


  // If just injected in clean mode, return existing comments unchanged
  if (!isCommented && wasJustInjected) {
    return existingComments;
  }

  let finalComments;

  if (isCommented) {
    // ========================================================================
    // COMMENTED MODE: Replace VCM with current state, preserving metadata
    // ========================================================================

    // Build map of existing comments by anchor
    const existingByKey = new Map();
    const existingByText = new Map();
    for (const existing of existingComments) {
      const key = buildContextKey(existing);
      if (!existingByKey.has(key)) {
        existingByKey.set(key, []);
      }
      existingByKey.get(key).push(existing);

      // Index by text to handle anchor changes (store array to handle duplicates)
      const textKey =
        existing.text ||
        (existing.block ? existing.block.map((b) => b.text).join("\n") : "");
      if (textKey && !existingByText.has(textKey)) {
        existingByText.set(textKey, existing);
      }
    }

    // Build map of "other" comments (private if processing shared, shared if processing private)
    const otherByKey = new Map();
    const otherByText = new Map();
    const matchedOther = new Set();

    for (const otherComment of otherComments) {
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
    }

    const claimMatch = (map, key) => {
      const candidates = map.get(key);
      if (!candidates || candidates.length === 0) return null;
      const candidate = candidates.find((c) => !matchedOther.has(c));
      if (!candidate) return null;
      matchedOther.add(candidate);
      const remaining = candidates.filter((c) => c !== candidate);
      if (remaining.length > 0) {
        map.set(key, remaining);
      } else {
        map.delete(key);
      }
      return candidate;
    };

    // Track which existing comments we've matched
    const matchedExisting = new Set();

    // Process current comments and match with existing to preserve metadata
    finalComments = currentComments.map((current) => {
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
      const candidates = existingByKey.get(key) || [];
      if (candidates.length > 0) {
        // Found match by anchor - preserve metadata
        const existing = candidates[0];
        matchedExisting.add(existing);
        candidates.shift();
        if (candidates.length === 0) {
          existingByKey.delete(key);
        }

        return {
          ...current,
          alwaysShow: existing.alwaysShow || undefined,
          // Preserve any other metadata fields here
        };
      }

      // No match by anchor - try matching by text (anchor might have changed)
      if (currentText && existingByText.has(currentText)) {
        const existing = existingByText.get(currentText);
        if (!matchedExisting.has(existing)) {
          matchedExisting.add(existing);
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
    // CLEAN MODE: Preserve hidden VCM comments, track new ones via text_cleanMode (shared) or direct update (private)
    // ========================================================================

    // Build map of existing comments by anchor + context hashes
    const existingByKey = new Map();
    for (const existing of existingComments) {
      const key = `${existing.type}:${existing.anchor}:${
        existing.prevHash || "null"
      }:${existing.nextHash || "null"}`;
      if (!existingByKey.has(key)) {
        existingByKey.set(key, []);
      }
      existingByKey.get(key).push(existing);
    }

    // Build set of "other" comment keys for filtering
    const otherKeys = new Set();
    const otherTexts = new Set();
    for (const otherComment of otherComments) {
      const key = `${otherComment.type}:${otherComment.anchor}:${
        otherComment.prevHash || "null"
      }:${otherComment.nextHash || "null"}`;
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
      const existingByText = new Map();
      for (const existing of existingComments) {
        const textKey =
          existing.text ||
          (existing.block ? existing.block.map((b) => b.text).join("\n") : "");
        if (textKey && !existingByText.has(textKey)) {
          existingByText.set(textKey, existing);
        }
      }

      // Track which existing comments we've matched
      const matchedExisting = new Set();

      // Process current comments
      for (const current of currentComments) {
        const key = `${current.type}:${current.anchor}:${
          current.prevHash || "null"
        }:${current.nextHash || "null"}`;
        const currentText =
          current.text ||
          (current.block ? current.block.map((b) => b.text).join("\n") : "");

        // Skip if this comment belongs to the "other" VCM (shared)
        if (otherKeys.has(key)) {
          continue;
        }

        // Match by text first (handles when comment moves)
        let existing = null;
        if (currentText && existingByText.has(currentText)) {
          const candidate = existingByText.get(currentText);
          if (!matchedExisting.has(candidate)) {
            existing = candidate;
            matchedExisting.add(existing);
            // Update anchor to new position
            existing.anchor = current.anchor;
            existing.prevHash = current.prevHash;
            existing.nextHash = current.nextHash;
            existing.originalLineIndex = current.originalLineIndex;
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
          const candidates = existingByKey.get(key) || [];
          if (candidates.length > 0 && !matchedExisting.has(candidates[0])) {
            existing = candidates[0];
            matchedExisting.add(existing);
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
          existingComments.push(current);
          matchedExisting.add(current);
        }
      }

      // Return all existing comments (updated in place)
      finalComments = existingComments;
    } else {
      // ====================================================================
      // SHARED MODE IN CLEAN: Track changes via text_cleanMode
      // ====================================================================

      // Build map by text_cleanMode content for matching
      const existingByTextCleanMode = new Map();
      for (const existing of existingComments) {
        if (existing.text_cleanMode) {
          const textKey =
            typeof existing.text_cleanMode === "string"
              ? existing.text_cleanMode
              : Array.isArray(existing.text_cleanMode)
              ? existing.text_cleanMode.map((b) => b.text).join("\n")
              : "";
          if (textKey && !existingByTextCleanMode.has(textKey)) {
            existingByTextCleanMode.set(textKey, existing);
          }
        }
      }

      // Track which existing comments we've matched
      const matchedInCleanMode = new Set();

      // Process current comments (typed in clean mode)
      for (const current of currentComments) {
        const key = `${current.type}:${current.anchor}:${
          current.prevHash || "null"
        }:${current.nextHash || "null"}`;
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
          existingByTextCleanMode.has(currentText) ||
          existingComments.some((ec) => {
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
        if (currentText && existingByTextCleanMode.has(currentText)) {
          const candidate = existingByTextCleanMode.get(currentText);
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
          const candidates = existingByKey.get(key) || [];
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
          existingComments.push(newComment);
          matchedInCleanMode.add(newComment);
        }
      }

      // Remove text_cleanMode from comments that were deleted in clean mode
      for (const existing of existingComments) {
        if (existing.text_cleanMode) {
          const key = `${existing.type}:${existing.anchor}`;
          const stillExists = currentComments.some(
            (c) => `${c.type}:${c.anchor}` === key
          );

          if (!stillExists) {
            // User deleted this comment in clean mode
            existing.text_cleanMode = null;
          }
        }
      }

      finalComments = existingComments;
    }
  }

  return finalComments;
}

module.exports = {
  processCommentSync,
  buildContextKey,
};
