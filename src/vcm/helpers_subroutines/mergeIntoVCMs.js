const { buildContextKey } = require("../../utils_copycode/buildContextKey");
const { getCommentText } = require("../../utils_copycode/getCommentText");
const { isAlwaysShow } = require("../../helpers_subroutines/alwaysShow");
const { isSameComment } = require("../../utils_copycode/isSameComment");

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
  allowSpacingUpdate = true, // boolean: only update spacing when comment is visible in the document
}) {
  const addKeyToMap = (map, comment, usePrimary = false) => {
    const key = buildContextKey(comment, { usePrimaryAnchor: usePrimary });
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(comment);
  };

  const updateAnchorMeta = (existing, current) => {
    existing.prevHash = current.prevHash;
    existing.anchor = current.anchor;
    existing.nextHash = current.nextHash;
    existing.prevHashText = current.prevHashText;
    existing.anchorText = current.anchorText;
    existing.nextHashText = current.nextHashText;
    existing.primaryPrevHash = current.primaryPrevHash;
    existing.primaryAnchor = current.primaryAnchor;
    existing.primaryNextHash = current.primaryNextHash;
    existing.primaryPrevHashText = current.primaryPrevHashText;
    existing.primaryAnchorText = current.primaryAnchorText;
    existing.primaryNextHashText = current.primaryNextHashText;
    existing.commentedLineIndex = current.commentedLineIndex;
    // Don't update spacing here - spacing should only change when actually edited
    // Spacing is preserved from VCM and only updated when comment is visible and spacing changes
  };

  const updateSpacing = (existing, current) => {
    existing.spacingBefore = current.spacingBefore;
    existing.spacingAfter = current.spacingAfter;
  };

  const isCleanModeCandidate = (comment) =>
    comment.text_cleanMode !== undefined ||
    (comment.type === "line" && comment.text === undefined) ||
    (comment.type === "block" && comment.block === undefined) ||
    (comment.type === "inline" && comment.text === undefined);

  const getCommentLineIndex = (comment) => {
    if (comment.type === "block") {
      const blockArray = Array.isArray(comment.block)
        ? comment.block
        : Array.isArray(comment.text_cleanMode)
          ? comment.text_cleanMode
          : null;
      const firstIdx = blockArray?.[0]?.commentedLineIndex;
      return typeof firstIdx === "number" ? firstIdx : null;
    }
    return typeof comment.commentedLineIndex === "number" ? comment.commentedLineIndex : null;
  };

  const shouldMatchCleanMode = (current, candidate) => {
    if (!candidate) return false;
    if (current.type === "inline") return true;
    const currentText = getCommentText(current);
    const candidateText = getCommentText(candidate);
    if (!currentText || !candidateText) return false;
    return currentText === candidateText;
  };

  const matchCleanModeByText = (current, candidate) => {
    if (!candidate) return false;
    if (isCleanModeCandidate(candidate)) {
      if (current.type === "line" || current.type === "block") {
        const currentIdx = getCommentLineIndex(current);
        const candidateIdx = getCommentLineIndex(candidate);
        return currentIdx !== null && candidateIdx !== null && currentIdx === candidateIdx;
      }
      return true;
    }

    return isSameComment(candidate, current);
  };



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
        addKeyToMap(vcmByKey, c, false);
        if (c.primaryAnchor !== undefined) {
          addKeyToMap(vcmByKey, c, true);
        }

        const textKey = getCommentText(c);
        if (textKey && !vcmByText.has(textKey)) vcmByText.set(textKey, c);
      }

      const claimed = new Set();

      // Update matched VCM comments in place
      for (const current of docComments) {
        const currentText = getCommentText(current);

        let existing = null;

        // Try primary key FIRST for consecutive comments (more specific match)
        if (current.primaryAnchor !== undefined) {
          const primaryKey = buildContextKey(current, { usePrimaryAnchor: true });
          const primaryCandidates = vcmByKey.get(primaryKey) || [];
          existing = primaryCandidates.find(x => !claimed.has(x)) || null;
        }

        // Fall back to regular key if no primary match
        if (!existing) {
          const key = buildContextKey(current);
          const candidates = vcmByKey.get(key) || [];
          existing = candidates.find(x => !claimed.has(x)) || null;
        }

        if (!existing && currentText && vcmByText.has(currentText)) {
          const cand = vcmByText.get(currentText);
          if (!claimed.has(cand)) existing = cand;
        }

        if (!existing) continue;

        claimed.add(existing);

        // Update existing comment in place
        console.log("[DEBUG mergeIntoVCMs PRIVATE] before updateAnchorMeta:", {
          currentText: getCommentText(current)?.substring(0, 30),
          currentPrimaryAnchor: current.primaryAnchor,
          currentPrimaryAnchorText: current.primaryAnchorText?.substring(0, 30),
          existingText: getCommentText(existing)?.substring(0, 30),
          existingPrimaryAnchor: existing.primaryAnchor,
          existingPrimaryAnchorText: existing.primaryAnchorText?.substring(0, 30),
        });
        updateAnchorMeta(existing, current);
        if (allowSpacingUpdate) {
          updateSpacing(existing, current); // Update spacing when comment is visible in commented mode
        }
        console.log("[DEBUG mergeIntoVCMs PRIVATE] after updateAnchorMeta:", {
          existingPrimaryAnchor: existing.primaryAnchor,
          existingPrimaryAnchorText: existing.primaryAnchorText?.substring(0, 30),
        });
        if (current.type === "inline") existing.text = current.text;
        if (current.type === "line") existing.text = current.text;
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
        addKeyToMap(vcmComByKEY, comment, false);
        if (comment.primaryAnchor !== undefined) {
          addKeyToMap(vcmComByKEY, comment, true);
        }

        const textKey = getCommentText(comment);
        if (textKey && !vcmComByTEXT.has(textKey)) {
          vcmComByTEXT.set(textKey, comment);
        }
      }

      const matchedVCMComments = new Set();
      const newlyAddedComments = new Set(); // Track newly added comments explicitly

      // Update matched VCM comments in place
      for (const current of docComments) {
        const currentText = getCommentText(current);

        let existing = null;

        // Try primary key FIRST for consecutive comments (more specific match)
        if (current.primaryAnchor !== undefined) {
          const primaryKey = buildContextKey(current, { usePrimaryAnchor: true });
          const primaryCandidates = vcmComByKEY.get(primaryKey) || [];
          if (primaryCandidates.length > 0) {
            existing = primaryCandidates.find(x => !matchedVCMComments.has(x)) || null;
            if (existing) {
              matchedVCMComments.add(existing);
            }
          }
        }

        // Fall back to regular key if no primary match
        if (!existing) {
          const key = buildContextKey(current);
          const candidates = vcmComByKEY.get(key) || [];
          if (candidates.length > 0) {
            existing = candidates.find(x => !matchedVCMComments.has(x)) || null;
            if (existing) {
              matchedVCMComments.add(existing);
            }
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
          updateAnchorMeta(existing, current);
          if (allowSpacingUpdate) {
            updateSpacing(existing, current); // Update spacing when comment is visible
          }
          if (current.type === "inline") existing.text = current.text;
          if (current.type === "line") existing.text = current.text;
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
      addKeyToMap(vcmComByKEY, comment, false);
      if (comment.primaryAnchor !== undefined) {
        addKeyToMap(vcmComByKEY, comment, true);
      }
    }

    const vcmComByTEXT = new Map();
    for (const comment of vcmComments) {
      const textKey = getCommentText(comment);
      if (!textKey) continue;
      if (!vcmComByTEXT.has(textKey)) vcmComByTEXT.set(textKey, []);
      vcmComByTEXT.get(textKey).push(comment);
    }

    if (isPrivateMode) {
      // ====================================================================
      // PRIVATE MODE IN CLEAN: Update anchors and content (same as shared)
      // ====================================================================

      // Build map by text for matching (handles cut/paste where anchor changes)
      const vcmComByTEXT = new Map();
      for (const existing of vcmComments) {
        const textKey = getCommentText(existing);
        if (!textKey) continue;
        if (!vcmComByTEXT.has(textKey)) {
          vcmComByTEXT.set(textKey, []);
        }
        vcmComByTEXT.get(textKey).push(existing);
      }

      // Track which existing comments we've matched
      const matchedVCMComments = new Set();

      // Process current comments (typed in clean mode or commented mode)
      for (const current of docComments) {
        const currentText = getCommentText(current);

        // Try primary key FIRST for consecutive comments (more specific match)
        let existing = null;
        if (current.primaryAnchor !== undefined) {
          const primaryKey = buildContextKey(current, { usePrimaryAnchor: true });
          const primaryCandidates = vcmComByKEY.get(primaryKey) || [];
          const candidate = primaryCandidates.find((c) => !matchedVCMComments.has(c)) || null;
          if (candidate && matchCleanModeByText(current, candidate)) {
            existing = candidate;
            matchedVCMComments.add(existing);
          }
        }

        // Fall back to regular key if no primary match
        if (!existing) {
          const key = buildContextKey(current);
          const candidates = vcmComByKEY.get(key) || [];
          if (candidates.length > 0) {
            const candidate = candidates.find((c) => !matchedVCMComments.has(c)) || null;
            if (candidate && matchCleanModeByText(current, candidate)) {
              existing = candidate;
              matchedVCMComments.add(existing);
            }
          }
        }

        // If no anchor match, try matching by text (handles cut/paste)
        if (!existing && currentText && vcmComByTEXT.has(currentText)) {
          const candidatesByText = vcmComByTEXT.get(currentText);
          const candidate = candidatesByText.find((c) => !matchedVCMComments.has(c)) || null;
          if (candidate && matchCleanModeByText(current, candidate)) {
            existing = candidate;
            matchedVCMComments.add(existing);
          }
        }

        if (existing) {
          // Found existing private comment - update it in place
          // Update content (may have been edited) using text_cleanMode in clean mode
          if (current.type === "inline") {
            if (current.text !== existing.text) {
              console.log(typeof existing.text_cleanMode, existing.text_cleanMode, "existing");
              console.log(typeof current.text, current.text, "current");
              existing.text_cleanMode = (existing.text_cleanMode).concat(current.text);
            } else {
              existing.text_cleanMode = null;
            }
          } else if (current.type === "line") {
            if (current.text !== existing.text) {
              existing.text_cleanMode = current.text;
            } else {
              existing.text_cleanMode = null;
            }
          } else if (current.type === "block") {
            const currentBlockText = Array.isArray(current.block)
              ? current.block.map((b) => b.text).join("\n")
              : "";
            const existingBlockText = Array.isArray(existing.block)
              ? existing.block.map((b) => b.text).join("\n")
              : "";
            if (currentBlockText !== existingBlockText) {
              existing.text_cleanMode = current.block;
            } else {
              existing.text_cleanMode = null;
            }
          }
          // Update anchor in case code moved
          updateAnchorMeta(existing, current);
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
      console.log("[CLEAN MODE SHARED] docComments:", docComments.length, "vcmComments:", vcmComments.length);

      // Track which existing comments we've matched
      const matchedInCleanMode = new Set();

      // Process current comments (typed in clean mode)
      for (const current of docComments) {
        console.log("[CLEAN MODE] Processing:", current.type, "text:", current.text);
        // Process as a comment for this VCM
        let existing = null;

        // Strong clean-mode match: same type + same commentedLineIndex
        const currentLineIdx = getCommentLineIndex(current);
        if (currentLineIdx !== null) {
          const lineKey = `${current.type}:${currentLineIdx}`;
          const lineCandidates = vcmComments.filter(
            (c) =>
              isCleanModeCandidate(c) &&
              getCommentLineIndex(c) === currentLineIdx &&
              c.type === current.type
          );
          const candidate = lineCandidates.find((c) => !matchedInCleanMode.has(c)) || null;
          if (candidate) {
            existing = candidate;
            matchedInCleanMode.add(existing);
          }
        }

        // Try primary key FIRST for consecutive comments (more specific match)
        if (!existing && current.primaryAnchor !== undefined) {
          const primaryKey = buildContextKey(current, { usePrimaryAnchor: true });
          const candidates = vcmComByKEY.get(primaryKey) || [];
          const candidate = candidates.find((c) => !matchedInCleanMode.has(c)) || null;
          if (candidate && matchCleanModeByText(current, candidate)) {
            existing = candidate;
            matchedInCleanMode.add(existing);
          }
        }

        // Fall back to regular key if no primary match
        if (!existing) {
          const key = buildContextKey(current);
          const candidates = vcmComByKEY.get(key) || [];
          const candidate = candidates.find((c) => !matchedInCleanMode.has(c)) || null;
          if (candidate && matchCleanModeByText(current, candidate)) {
            existing = candidate;
            matchedInCleanMode.add(existing);
          }
        }

        if (!existing) {
          const currentText = getCommentText(current);
          if (currentText && vcmComByTEXT.has(currentText)) {
            const candidates = vcmComByTEXT.get(currentText);
            const candidate = candidates.find((c) => !matchedInCleanMode.has(c)) || null;
            if (candidate && matchCleanModeByText(current, candidate)) {
              existing = candidate;
              matchedInCleanMode.add(existing);
            }
          }
        }

        console.log("[CLEAN MODE] existing found?", !!existing, "for inline:", current.type === "inline");
        if (existing) {
          console.log("[CLEAN MODE] existing.text_cleanMode:", existing.text_cleanMode, "existing.text:", existing.text);
          // Update anchor/position fields (code may have moved)
          updateAnchorMeta(existing, current);

          if (current.type === "inline") {
            if (current.text !== existing.text) {
              console.log(typeof existing.text_cleanMode, existing.text_cleanMode, "existing");
              console.log(typeof current.text, current.text, "current");
              existing.text_cleanMode = (existing.text_cleanMode).concat(current.text);
            } else {
              existing.text_cleanMode = null;
            }
          } else if (current.type === "line") {
            if (current.text !== existing.text) {
              existing.text_cleanMode = current.text;
            } else {
              existing.text_cleanMode = null;
            }
          } else if (current.type === "block") {
            const currentBlockText = Array.isArray(current.block)
              ? current.block.map((b) => b.text).join("\n")
              : "";
            const existingBlockText = Array.isArray(existing.block)
              ? existing.block.map((b) => b.text).join("\n")
              : "";
            if (currentBlockText !== existingBlockText) {
              existing.text_cleanMode = current.block;
            } else {
              existing.text_cleanMode = null;
            }
          }
        } else {
          // No match - this is a newly typed comment in clean mode
          // SEPARATION CONTRACT: Each store operates independently
          // New comments go into THIS store (shared), regardless of what's in other store (private)
          const lineIdx = getCommentLineIndex(current);
          if (lineIdx !== null) {
            const lineCandidate = vcmComments.find(
              (c) =>
                isCleanModeCandidate(c) &&
                c.type === current.type &&
                getCommentLineIndex(c) === lineIdx
            );
            if (lineCandidate) {
              updateAnchorMeta(lineCandidate, current);
              console.log(typeof lineCandidate.text_cleanMode, lineCandidate.text_cleanMode, "lineCandidate");
              console.log(typeof current.text, current.text, "current");
              if (current.type === "inline") lineCandidate.text_cleanMode = (lineCandidate.text_cleanMode).concat(current.text);
              if (current.type === "line") lineCandidate.text_cleanMode = current.text;
              if (current.type === "block") lineCandidate.text_cleanMode = current.block;
              matchedInCleanMode.add(lineCandidate);
              continue;
            }
          }
          const newComment = { ...current };
          if (current.type === "inline") {
            console.log(typeof newComment.text_cleanMode, newComment.text_cleanMode, "newComment");
            console.log(typeof current.text, current.text, "current");
            newComment.text_cleanMode = (newComment.text_cleanMode).concat(current.text);
            delete newComment.text;
          } else if (current.type === "line") {
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
          const existingKey = buildContextKey(existing);
          const existingPrimaryKey = existing.primaryAnchor !== undefined
            ? buildContextKey(existing, { usePrimaryAnchor: true })
            : null;
          const stillExists = docComments.some((c) => {
            const docKey = buildContextKey(c);
            if (docKey === existingKey) return true;
            if (existingPrimaryKey && c.primaryAnchor !== undefined) {
              const docPrimaryKey = buildContextKey(c, { usePrimaryAnchor: true });
              if (docPrimaryKey === existingPrimaryKey) return true;
            }
            return false;
          });

          if (!stillExists) {
            // User deleted this comment in clean mode
            existing.text_cleanMode = null;
          }
        }
      }

      // Enforce single clean-mode object per line index
      const seenCleanLine = new Set();
      finalComments = vcmComments.filter((comment) => {
        if (!isCleanModeCandidate(comment)) return true;
        const lineIdx = getCommentLineIndex(comment);
        if (lineIdx === null) return true;
        const key = `${comment.type}:${lineIdx}`;
        if (seenCleanLine.has(key)) return false;
        seenCleanLine.add(key);
        return true;
      });
    }
  }

  return finalComments || [];
}

module.exports = {
  mergeIntoVCMs,
  buildContextKey,
};
