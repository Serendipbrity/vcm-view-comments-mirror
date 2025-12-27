const { buildContextKey } = require("../buildContextKey");
const { getCommentText } = require("../getCommentText");
const { isAlwaysShow } = require("../alwaysShow");

// ============================================================================
// mergeIntoVCMs() determines:
// ============================================================================
// what’s in the editor right now (docComments)
// what’s in the VCM JSON (vcmComments)

// It decides how to:
// preserve metadata (alwaysShow, anchors, etc.)
// avoid shared/private cross-contamination
// track clean-mode edits via text_cleanMode
// update private comments correctly in clean mode
// It Returns: “here are the updated comments that should be saved back into this VCM”.
// ============================================================================
function mergeIntoVCMs({
  isCommented, // boolean: true = commented mode, false = clean mode
  docComments, // array: comments extracted from current document
  vcmComments, // array: comments from current VCM file (will be modified in place for clean mode)
  isPrivateMode = false, // boolean: true = processing private comments, false = shared
  wasJustInjected = false, // boolean: skip processing in clean mode if just injected
}) {


  // If we are in clean mode and wasJustInjected is true → bail out, return vcmComments unchanged.
  // That prevents the "I just injected from VCM and now I think these are new clean-mode edits" bug.
  if (!isCommented && wasJustInjected) {
    return vcmComments;
  }

  // PRIVATE MODE REFUSAL GUARD: Private VCM should only contain private comments
  if (isPrivateMode) {
    const nonPrivate = vcmComments.find(c => c.isPrivate !== true);
    if (nonPrivate) {
      // Private VCM is polluted with non-private comment - refuse to proceed
      throw new Error(`Private VCM contains non-private comment at anchor ${nonPrivate.anchor}. Store separation violated.`);
    }
  }

  let finalComments;

  // ========================================================================
  // COMMENTED MODE: Replace VCM with current state, preserving metadata
  // ========================================================================
  // In commented mode, the source of truth is the document, not the VCM.
  if (isCommented) {
    if (isPrivateMode) {
      // ====================================================================
      // PRIVATE MODE: Update in-place and preserve ALL VCM comments (including hidden)
      // ====================================================================
      // Build map of current vcm comments by anchor for the current vcm (shared or private depending on which file we are syncing rn)
      const vcmByKey = new Map(); // context key catches same location, even if identical text occurs elsewhere.
      const vcmByText = new Map(); // text mapping catches same comment if its anchor changed (code moved).

      for (const c of vcmComments) {
        const key = buildContextKey(c);
        if (!vcmByKey.has(key)) vcmByKey.set(key, []);
        vcmByKey.get(key).push(c);

        const textKey = getCommentText(c);
        if (textKey && !vcmByText.has(textKey)) vcmByText.set(textKey, c);
      }

      const claimed = new Set();

      // Update matched VCM comments in place
      for (const current of docComments) {
        const key = buildContextKey(current);
        const currentText = getCommentText(current);

        let existing = null;
        const candidates = vcmByKey.get(key) || [];
        existing = candidates.find(x => !claimed.has(x)) || null;

        if (!existing && currentText && vcmByText.has(currentText)) {
          const cand = vcmByText.get(currentText);
          if (!claimed.has(cand)) existing = cand;
        }

        if (!existing) continue;

        claimed.add(existing);

        // Update existing comment in place
        existing.anchor = current.anchor;
        existing.prevHash = current.prevHash;
        existing.nextHash = current.nextHash;
        existing.commentedLineIndex = current.commentedLineIndex;
        existing.anchorText = current.anchorText;
        if (current.type === "inline") existing.text = current.text;
        if (current.type === "block") existing.block = current.block;
        existing.isPrivate = true;
      }

      // Return ALL VCM comments (preserves hidden private comments)
      finalComments = vcmComments.map(c => ({ ...c, isPrivate: true }));

    } else {
      // ====================================================================
      // SHARED MODE: Update in-place and preserve VCM comments (for undo/redo)
      // ====================================================================
      const vcmComByKEY = new Map();
      const vcmComByTEXT = new Map();

      for (const comment of vcmComments) {
        const key = buildContextKey(comment);
        if (!vcmComByKEY.has(key)) {
          vcmComByKEY.set(key, []);
        }
        vcmComByKEY.get(key).push(comment);

        const textKey = getCommentText(comment);
        if (textKey && !vcmComByTEXT.has(textKey)) {
          vcmComByTEXT.set(textKey, comment);
        }
      }

      const matchedVCMComments = new Set();
      const newlyAddedComments = new Set(); // Track newly added comments explicitly

      // Update matched VCM comments in place
      for (const current of docComments) {
        const key = buildContextKey(current);
        const currentText = getCommentText(current);

        let existing = null;

        // Try to match by context key first
        const candidates = vcmComByKEY.get(key) || [];
        if (candidates.length > 0) {
          existing = candidates.find(x => !matchedVCMComments.has(x)) || null;
          if (existing) {
            matchedVCMComments.add(existing);
          }
        }

        // No match by key - try matching by text (anchor might have changed)
        if (!existing && currentText && vcmComByTEXT.has(currentText)) {
          const candidate = vcmComByTEXT.get(currentText);
          if (!matchedVCMComments.has(candidate)) {
            existing = candidate;
            matchedVCMComments.add(existing);
          }
        }

        if (existing) {
          // Update existing comment in place
          existing.anchor = current.anchor;
          existing.prevHash = current.prevHash;
          existing.nextHash = current.nextHash;
          existing.commentedLineIndex = current.commentedLineIndex;
          existing.anchorText = current.anchorText;
          if (current.type === "inline") existing.text = current.text;
          if (current.type === "block") existing.block = current.block;
        } else {
          // New comment - add to VCM and track it
          const newComment = { ...current }; // Clone to avoid identity issues
          vcmComments.push(newComment);
          newlyAddedComments.add(newComment);
        }
      }

      // Keep matched VCM comments and newly added comments
      finalComments = vcmComments;
    }

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

    if (isPrivateMode) {
      // ====================================================================
      // PRIVATE MODE IN CLEAN: Update anchors and content (same as shared)
      // ====================================================================

      // Build map by text for matching (handles cut/paste where anchor changes)
      const vcmComByTEXT = new Map();
      for (const existing of vcmComments) {
        const textKey = getCommentText(existing);
        if (textKey && !vcmComByTEXT.has(textKey)) {
          vcmComByTEXT.set(textKey, existing);
        }
      }

      // Track which existing comments we've matched
      const matchedVCMComments = new Set();

      // Process current comments (typed in clean mode or commented mode)
      for (const current of docComments) {
        const key = buildContextKey(current);
        const currentText = getCommentText(current);

        // Try to match by anchor first (for existing private VCM comments)
        let existing = null;
        const candidates = vcmComByKEY.get(key) || [];
        if (candidates.length > 0 && !matchedVCMComments.has(candidates[0])) {
          existing = candidates[0];
          matchedVCMComments.add(existing);
        }

        // If no anchor match, try matching by text (handles cut/paste)
        if (!existing && currentText && vcmComByTEXT.has(currentText)) {
          const candidate = vcmComByTEXT.get(currentText);
          if (!matchedVCMComments.has(candidate)) {
            existing = candidate;
            matchedVCMComments.add(existing);
          }
        }

        if (existing) {
          // Found existing private comment - update it in place
          // Update content (may have been edited)
          existing.text = current.text;
          existing.block = current.block;
          // Update anchor in case code moved
          existing.anchor = current.anchor;
          existing.prevHash = current.prevHash;
          existing.nextHash = current.nextHash;
          existing.commentedLineIndex = current.commentedLineIndex;
          existing.anchorText = current.anchorText;
          // Ensure isPrivate flag is preserved/set
          existing.isPrivate = true;
        }
        // Note: If no match, don't add to vcmComments
        // Private VCM only contains explicitly marked private comments
        // New comments go to shared VCM by default
      }

      // IMPORTANT: Keep ALL existing private VCM comments, even if not visible/matched
      // This ensures hidden private comments persist when private toggle is OFF
      finalComments = vcmComments.map(c => {
        // Ensure all private VCM comments keep their isPrivate flag
        if (c.isPrivate !== true) {
          c.isPrivate = true;
        }
        return c;
      });
    } else {
      // ====================================================================
      // SHARED MODE IN CLEAN: Track changes via text_cleanMode
      // ====================================================================

      // Build map by original VCM text/block for matching (matches unedited comments)
      const vcmComByTEXT = new Map();
      for (const existing of vcmComments) {
        const textKey = getCommentText(existing);
        if (textKey && !vcmComByTEXT.has(textKey)) {
          vcmComByTEXT.set(textKey, existing);
        }
      }

      // Build map by text_cleanMode content for matching (matches already-edited comments)
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
        const currentText = getCommentText(current);

        // Process as a comment for this VCM
        let existing = null;

        // First, try to match by original VCM text/block (most common case - unedited comment)
        if (currentText && vcmComByTEXT.has(currentText)) {
          const candidate = vcmComByTEXT.get(currentText);
          if (!matchedInCleanMode.has(candidate)) {
            existing = candidate;
            matchedInCleanMode.add(existing);
          }
        }

        // If no match, try text_cleanMode (handles case where comment was previously edited in clean mode)
        if (!existing && currentText && vcmComByTEXTCleanMode.has(currentText)) {
          const candidate = vcmComByTEXTCleanMode.get(currentText);
          if (!matchedInCleanMode.has(candidate)) {
            existing = candidate;
            matchedInCleanMode.add(existing);
            // Update anchor to new position (comment moved with code)
            existing.anchor = current.anchor;
            existing.prevHash = current.prevHash;
            existing.nextHash = current.nextHash;
            existing.anchorText = current.anchorText;
          }
        }

        // If still no text match, try anchor match (for VCM comments)
        if (!existing) {
          const candidates = vcmComByKEY.get(key) || [];
          if (candidates.length > 0 && !matchedInCleanMode.has(candidates[0])) {
            existing = candidates[0];
            matchedInCleanMode.add(existing);
          }
        }

        if (existing) {
          // Special handling for alwaysShow comments: update text/block directly (like commented mode)
          if (isAlwaysShow(existing)) {
            // Update content directly (no text_cleanMode for alwaysShow)
            existing.text = current.text;
            existing.block = current.block;
            // Update anchor in case code moved
            existing.anchor = current.anchor;
            existing.prevHash = current.prevHash;
            existing.nextHash = current.nextHash;
            existing.commentedLineIndex = current.commentedLineIndex;
            existing.anchorText = current.anchorText;
          } else {
            // Regular comments: use text_cleanMode
            // But ALWAYS update anchor/position fields (code may have moved)
            existing.anchor = current.anchor;
            existing.prevHash = current.prevHash;
            existing.nextHash = current.nextHash;
            existing.commentedLineIndex = current.commentedLineIndex;
            existing.anchorText = current.anchorText;

            if (current.type === "inline") {
              if (current.text !== existing.text) {
                existing.text_cleanMode = current.text;
              } else {
                existing.text_cleanMode = null;
              }
            } else if (current.type === "block") {
              const existingTexts = getCommentText(existing);
              const currentTexts = getCommentText(current);
              const blocksIdentical = existingTexts === currentTexts;

              if (!blocksIdentical) {
                existing.text_cleanMode = current.block;
              } else {
                existing.text_cleanMode = null;
              }
            }
          }
        } else {
          // No match - this is a newly typed comment in clean mode
          // SEPARATION CONTRACT: Each store operates independently
          // New comments go into THIS store (shared), regardless of what's in other store (private)
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
  mergeIntoVCMs,
  buildContextKey,
};
