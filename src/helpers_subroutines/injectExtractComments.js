const {
  getCommentMarkersForFile,
  getLineMarkersForFile,
  getBlockMarkersForFile,
} = require("../utils_copycode/commentMarkers");
const { hashLine } = require("../utils_copycode/hash");
const { isolateCodeLine, findInlineCommentStart } = require("../utils_copycode/lineUtils");
const { parseDocComs, addPrimaryAnchors } = require("../vcm/utils_copycode/parseDocComs");
const { buildContextKey } = require("../utils_copycode/buildContextKey");
const { getCommentText } = require("../utils_copycode/getCommentText");
const { isSameComment } = require("../utils_copycode/isSameComment");
const { isAlwaysShow } = require("./alwaysShow");

/**
 * Inject ONLY the provided comments (except alwaysShow, which is never injected).
 * Caller passes either shared list or private list.
 * @param {boolean} sharedVisible - Whether shared comments are visible in the target document
 * @param {boolean} privateVisible - Whether private comments are visible in the target document
 */
function injectComments(cleanText, filePath, comments = [], sharedVisible = true, privateVisible = false) {
  // split("\n") turns the code into an array of lines so you can loop by index.
  const lines = cleanText.split("\n");
  const result = [];  // Where you'll push lines and comments in order, then join back later.
  const pushLine = (line) => {
    result.push(line);
  };

  // Get comment markers for this file type
  const commentMarkers = getCommentMarkersForFile(filePath);

  // Never inject alwaysShow (those live physically in the file)
  const commentsToInject = (comments || []).filter(c => !isAlwaysShow(c));

  // Create an empty Map to link each line's unique hash → all positions in the file where that line exists.
  // (handles duplicates)
  // You use a Map instead of an object because the keys (hash strings) are not simple variable names and you may have duplicates.
  const lineHashToIndices = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

      const hash = hashLine(isolateCodeLine(lines[i], commentMarkers), 0);
      if (!lineHashToIndices.has(hash)) { // If this hash hasn't been seen before
        lineHashToIndices.set(hash, []); // Create a new list as its value in the map.
      }
      // Add the current line's index to that hash's list
      // This allows for duplicate code lines:
      // If the same text appears twice (say, import torch on lines 3 and 20),
      // the map will have: "hash(import torch)" → [3, 20]
      // So later you can decide which one the comment should attach to.
    lineHashToIndices.get(hash).push(i);

    const commentHash = hashLine(lines[i].trim(), 0);
    if (commentHash !== hash) {
      if (!lineHashToIndices.has(commentHash)) {
        lineHashToIndices.set(commentHash, []);
      }
      lineHashToIndices.get(commentHash).push(i);
    }
  }

  // Build a virtual map of comment hashes to their intended injection positions
  // This allows consecutive comments to anchor to other comments being injected
  const commentHashToPosition = new Map();
  for (const comment of commentsToInject) {
    let commentHash = null;
    if (comment.type === "line") {
      const lineText = (comment.text || "").trim();
      if (lineText) commentHash = hashLine(lineText, 0);
    } else if (comment.type === "block" && comment.block && comment.block.length > 0) {
      const blockText = ((comment.block[0] && comment.block[0].text) || "").trim();
      if (blockText) commentHash = hashLine(blockText, 0);
    }

    if (commentHash) {
      // Map this comment's hash to the code line it will be inserted above
      // We'll use the anchor to find the position (will be refined later with actual injection order)
      if (!commentHashToPosition.has(commentHash)) {
        commentHashToPosition.set(commentHash, comment);
      }
    }
  }

  const shouldUsePrimaryAnchors = commentsToInject.some(
    (c) => c.isPrivate && c.primaryAnchor
  );
  let existingCommentsByPrimaryKey = null;
  let existingCommentsByKey = null;
  let existingCommentHashToIndices = null;
  if (shouldUsePrimaryAnchors) {
    existingCommentHashToIndices = new Map();
    existingCommentsByPrimaryKey = new Map();
    existingCommentsByKey = new Map();
    const existingComments = parseDocComs(cleanText, filePath);
    addPrimaryAnchors(existingComments, { lines });
    for (const c of existingComments) {
      const text = getCommentText(c);
      if (!text) continue;
      const hash = hashLine(text, 0);
      if (!existingCommentHashToIndices.has(hash)) {
        existingCommentHashToIndices.set(hash, []);
      }
      const indexToUse =
        c.type === "block" && Array.isArray(c.block) && c.block.length > 0
          ? c.block[0].commentedLineIndex
          : c.commentedLineIndex;
      if (indexToUse !== undefined) {
        existingCommentHashToIndices.get(hash).push(indexToUse);
      }
      // Build map by full primary context key
      if (c.primaryAnchor !== undefined) {
        const primaryKey = buildContextKey(c, { usePrimaryAnchor: true });
        if (!existingCommentsByPrimaryKey.has(primaryKey)) {
          existingCommentsByPrimaryKey.set(primaryKey, []);
        }
        existingCommentsByPrimaryKey.get(primaryKey).push({ comment: c, index: indexToUse });
      }
      // Build map by full non-primary context key
      const key = buildContextKey(c, { usePrimaryAnchor: false });
      if (!existingCommentsByKey.has(key)) {
        existingCommentsByKey.set(key, []);
      }
      existingCommentsByKey.get(key).push({ comment: c, index: indexToUse });
    }
  }

  // Helper: Find best matching line index among duplicates using context hashes
  // When several lines share the same content hash, this function decides which one should anchor the comment.
  const findBestMatch = (comment, candidateIndices, usedIndices) => {
    if (candidateIndices.length === 1) { // Shortcut: if only one match: done.
      return candidateIndices[0]; // return that one match
    }

    // When multiple identical code lines exist (same hash), candidateIndices might have several matches.
    // usedIndices tracks lines already assigned to other comments.
    // → You filter them out so you don’t attach multiple comment blocks to the same line.
    const available = candidateIndices.filter(idx => !usedIndices.has(idx));
    if (available.length === 0) {
      // All used, fall back to any candidate
      return candidateIndices[0];
    }

    if (available.length === 1) { // if only one available
      return available[0]; // return that one. No need to score.
    }

    // Determine which prev/next hashes to use for scoring based on visibility context
    let prevHashToUse = comment.prevHash;
    let nextHashToUse = comment.nextHash;
    const hasPrim = ((comment.primaryPrevHash !== undefined) || (comment.primaryNextHash !== undefined) || (comment.primaryAnchor !== undefined))
    // Use primary hashes if available for consecutive comments
    if (hasPrim) {
      prevHashToUse = comment.primaryPrevHash;
      nextHashToUse = comment.primaryNextHash;
    }

    // Build a list of possible line indices, each with a "score" indicating how well its context fits.
    const scores = available.map(idx => {
      let score = 0;

      // Find previous non-blank nearest neighbor code line
      let prevIdx = -1;
      for (let j = idx - 1; j >= 0; j--) {
        if (lines[j].trim()) {
          prevIdx = j;
          break;
        }
      }

      // Find next non-blank nearest neighbor code line
      let nextIdx = -1;
      for (let j = idx + 1; j < lines.length; j++) {
        if (lines[j].trim()) {
          nextIdx = j;
          break;
        }
      }

      // Compare these neighbor lines to the comment's stored hashes and score based on matching context
      // Add 10 points for each matching context hash.
      // Higher score = better contextual fit.
      if (prevHashToUse && prevIdx >= 0) {
        const prevHash = hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0);
        if (prevHash === prevHashToUse) score += 10;
      }

      if (nextHashToUse && nextIdx >= 0) {
        const nextHash = hashLine(isolateCodeLine(lines[nextIdx], commentMarkers), 0);
        if (nextHash === nextHashToUse) score += 10;
      }

      // Calculate distance from original commentedLineIndex (if available) for tiebreaking
      const distance = comment.commentedLineIndex !== undefined
        ? Math.abs(idx - comment.commentedLineIndex)
        : Infinity;

      return { idx, score, distance };
    });

    // Sort by score (descending), then by distance from original position (ascending), then by line index (ascending)
    scores.sort((a, b) => (b.score - a.score) || (a.distance - b.distance) || (a.idx - b.idx));
    return scores[0].idx;
  };

  const blockComments = commentsToInject.filter(c => c.type === "block").sort((a, b) => (a.block?.[0]?.commentedLineIndex || 0) - (b.block?.[0]?.commentedLineIndex || 0));

  const lineComments = commentsToInject
    .filter(c => c.type === "line")
    .sort((a, b) => (a.commentedLineIndex || 0) - (b.commentedLineIndex || 0));

  const inlineComments = commentsToInject
    .filter(c => c.type === "inline")
    .sort((a, b) => (a.commentedLineIndex || 0) - (b.commentedLineIndex || 0));

  // Track which indices we've already used
  const usedIndices = new Set();

  // Build maps: Map() is a key-value store where keys can be any type.
  // key = line index of code
  // value = array of block comment objects that attach to that code line.
  // This is what injectComments() uses later to decide “for line i, which comments go above it?”
  const blockMap = new Map();
  const lineMap = new Map();
  const inlineMap = new Map();

  // Loops through every block comment that needs to be inserted.
  for (const block of blockComments) {
    let indices = null;

    // For comments with primary fields, try to match by full primary context key first
    // This ensures we find the exact position even when individual hashes might match multiple locations
    if (block.primaryAnchor !== undefined && existingCommentsByPrimaryKey) {
      const primaryKey = buildContextKey(block, { usePrimaryAnchor: true });
      const matches = existingCommentsByPrimaryKey.get(primaryKey);
      if (matches?.length) {
        // Found exact match by primary context key - inject at that comment's position
        indices = [matches[0].index];
      }
    }

    // If no primary key match, try primaryAnchor as code line or existing comment
    if (!indices?.length && block.primaryAnchor) {
      indices = lineHashToIndices.get(block.primaryAnchor);
      if (!indices?.length && existingCommentHashToIndices?.has(block.primaryAnchor)) {
        indices = existingCommentHashToIndices.get(block.primaryAnchor);
      }
      // If not found, check if it's a comment being injected
      if (!indices?.length && commentHashToPosition.has(block.primaryAnchor)) {
        const targetComment = commentHashToPosition.get(block.primaryAnchor);
        indices = lineHashToIndices.get(targetComment.anchor);
      }
    }

    // Fall back to primary context hashes (can be comments or code)
    // Same logic as non-primary fallback, but checks both code lines and existing comments
    if (!indices?.length && (block.primaryPrevHash || block.primaryNextHash)) {
      // Find primaryPrevHash - could be code or comment
      let prevIndices = block.primaryPrevHash ? lineHashToIndices.get(block.primaryPrevHash) : null;
      if (!prevIndices?.length && block.primaryPrevHash && existingCommentHashToIndices?.has(block.primaryPrevHash)) {
        prevIndices = existingCommentHashToIndices.get(block.primaryPrevHash);
      }

      // Find primaryNextHash - could be code or comment
      let nextIndices = block.primaryNextHash ? lineHashToIndices.get(block.primaryNextHash) : null;
      if (!nextIndices?.length && block.primaryNextHash && existingCommentHashToIndices?.has(block.primaryNextHash)) {
        nextIndices = existingCommentHashToIndices.get(block.primaryNextHash);
      }

      if (prevIndices?.length && nextIndices?.length) {
        // Both prev and next found - comment should go between them
        for (const prevIdx of prevIndices) {
          for (const nextIdx of nextIndices) {
            if (nextIdx > prevIdx) {
              indices = [prevIdx + 1];
              break;
            }
          }
          if (indices?.length) break;
        }
      } else if (prevIndices?.length) {
        // Only prev found - inject after it
        indices = [prevIndices[prevIndices.length - 1] + 1];
      } else if (nextIndices?.length) {
        // Only next found - inject before it
        indices = [nextIndices[0]];
      }
    }

    // Fallback to full non-primary context key
    if (!indices?.length && existingCommentsByKey) {
      const key = buildContextKey(block, { usePrimaryAnchor: false });
      const matches = existingCommentsByKey.get(key);
      if (matches?.length) {
        indices = [matches[0].index];
      }
    }

    // Fall back to non-primary context hashes (code-only)
    if (!indices?.length && (block.prevHash || block.nextHash)) {
      const prevIndices = block.prevHash ? lineHashToIndices.get(block.prevHash) : null;
      const nextIndices = block.nextHash ? lineHashToIndices.get(block.nextHash) : null;

      if (prevIndices?.length && nextIndices?.length) {
        // Both prev and next found - comment should go between them
        for (const prevIdx of prevIndices) {
          for (const nextIdx of nextIndices) {
            if (nextIdx > prevIdx) {
              indices = [prevIdx + 1]; // Inject after prev line
              break;
            }
          }
          if (indices?.length) break;
        }
      } else if (prevIndices?.length) {
        // Only prev found - inject after it
        indices = [prevIndices[0] + 1];
      } else if (nextIndices?.length) {
        // Only next found - inject before it
        indices = [nextIndices[0]];
      }
    }

    if (!indices?.length) {
      continue;
    }

    const targetIndex = findBestMatch(block, indices, usedIndices);
    usedIndices.add(targetIndex); // Adds the target index to usedIndices (taken) so you don't double-assign it.

      // if the map doesnt exist yet for this index
      if (!blockMap.has(targetIndex)) {
        // initialize an empty array for it
        blockMap.set(targetIndex, []);
      }
      // Actually stores the comment object(s) in that array — meaning:
      // "When reinjecting, for this line index, insert this block comment above it."
      blockMap.get(targetIndex).push(block);
  }

  for (const lineComment of lineComments) {
    let indices = null;

    // For comments with primary fields, try to match by full primary context key first
    if (lineComment.primaryAnchor !== undefined && existingCommentsByPrimaryKey) {
      const primaryKey = buildContextKey(lineComment, { usePrimaryAnchor: true });
      const matches = existingCommentsByPrimaryKey.get(primaryKey);
      if (matches?.length) {
        indices = [matches[0].index];
      }
    }

    // If no primary key match, try primaryAnchor as code line or existing comment
    if (!indices?.length && lineComment.primaryAnchor) {
      indices = lineHashToIndices.get(lineComment.primaryAnchor);
      if (!indices?.length && existingCommentHashToIndices?.has(lineComment.primaryAnchor)) {
        indices = existingCommentHashToIndices.get(lineComment.primaryAnchor);
      }
      // If not found, check if it's a comment being injected
      if (!indices?.length && commentHashToPosition.has(lineComment.primaryAnchor)) {
        const targetComment = commentHashToPosition.get(lineComment.primaryAnchor);
        indices = lineHashToIndices.get(targetComment.anchor);
      }
    }

    // Fall back to primary context hashes (can be comments or code)
    if (!indices?.length && (lineComment.primaryPrevHash || lineComment.primaryNextHash)) {
      // Find primaryPrevHash - could be code or comment
      let prevIndices = lineComment.primaryPrevHash ? lineHashToIndices.get(lineComment.primaryPrevHash) : null;
      if (!prevIndices?.length && lineComment.primaryPrevHash && existingCommentHashToIndices?.has(lineComment.primaryPrevHash)) {
        prevIndices = existingCommentHashToIndices.get(lineComment.primaryPrevHash);
      }

      // Find primaryNextHash - could be code or comment
      let nextIndices = lineComment.primaryNextHash ? lineHashToIndices.get(lineComment.primaryNextHash) : null;
      if (!nextIndices?.length && lineComment.primaryNextHash && existingCommentHashToIndices?.has(lineComment.primaryNextHash)) {
        nextIndices = existingCommentHashToIndices.get(lineComment.primaryNextHash);
      }

      if (prevIndices?.length && nextIndices?.length) {
        // Both prev and next found - comment should go between them
        for (const prevIdx of prevIndices) {
          for (const nextIdx of nextIndices) {
            if (nextIdx > prevIdx) {
              indices = [prevIdx + 1];
              break;
            }
          }
          if (indices?.length) break;
        }
      } else if (prevIndices?.length) {
        // Only prev found - inject after it
        indices = [prevIndices[prevIndices.length - 1] + 1];
      } else if (nextIndices?.length) {
        // Only next found - inject before it
        indices = [nextIndices[0]];
      }
    }

    // Fallback to full non-primary context key
    if (!indices?.length && existingCommentsByKey) {
      const key = buildContextKey(lineComment, { usePrimaryAnchor: false });
      const matches = existingCommentsByKey.get(key);
      if (matches?.length) {
        indices = [matches[0].index];
      }
    }

    // Fall back to non-primary context hashes (code-only)
    if (!indices?.length && (lineComment.prevHash || lineComment.nextHash)) {
      const prevIndices = lineComment.prevHash ? lineHashToIndices.get(lineComment.prevHash) : null;
      const nextIndices = lineComment.nextHash ? lineHashToIndices.get(lineComment.nextHash) : null;

      if (prevIndices?.length && nextIndices?.length) {
        // Both prev and next found - comment should go between them
        for (const prevIdx of prevIndices) {
          for (const nextIdx of nextIndices) {
            if (nextIdx > prevIdx) {
              indices = [prevIdx + 1]; // Inject after prev line
              break;
            }
          }
          if (indices?.length) break;
        }
      } else if (prevIndices?.length) {
        // Only prev found - inject after it
        indices = [prevIndices[0] + 1];
      } else if (nextIndices?.length) {
        // Only next found - inject before it
        indices = [nextIndices[0]];
      }
    }

    if (!indices?.length) continue;

    const targetIndex = findBestMatch(lineComment, indices, usedIndices);
    // NOTE: Do NOT add to usedIndices - multiple line comments can share the same anchor

    if (!lineMap.has(targetIndex)) {
      lineMap.set(targetIndex, []);
    }
    lineMap.get(targetIndex).push(lineComment);
  }

  const addAdjacentCodeLine = (startIdx, step, out) => {
    for (let j = startIdx; j >= 0 && j < lines.length; j += step) {
      if (lines[j].trim()) {
        out.add(j);
        return;
      }
    }
  };

  for (const inline of inlineComments) {
    const candidateIndices = new Set();

    if (inline.anchor) {
      const anchorIndices = lineHashToIndices.get(inline.anchor);
      if (anchorIndices?.length) {
        anchorIndices.forEach((idx) => candidateIndices.add(idx));
      }
    }

    if (candidateIndices.size === 0 && (inline.prevHash || inline.nextHash)) {
      const prevIndices = inline.prevHash ? lineHashToIndices.get(inline.prevHash) : null;
      const nextIndices = inline.nextHash ? lineHashToIndices.get(inline.nextHash) : null;

      if (prevIndices?.length && nextIndices?.length) {
        for (const prevIdx of prevIndices) {
          for (const nextIdx of nextIndices) {
            if (nextIdx <= prevIdx) continue;
            for (let j = prevIdx + 1; j < nextIdx; j++) {
              if (lines[j].trim()) candidateIndices.add(j);
            }
          }
        }
      } else if (prevIndices?.length) {
        prevIndices.forEach((idx) => addAdjacentCodeLine(idx + 1, 1, candidateIndices));
      } else if (nextIndices?.length) {
        nextIndices.forEach((idx) => addAdjacentCodeLine(idx - 1, -1, candidateIndices));
      }
    }

    const indices = candidateIndices.size > 0 ? Array.from(candidateIndices) : null;
    if (!indices?.length) continue;

    const targetIndex = findBestMatch(inline, indices, usedIndices);
    if (!inlineMap.has(targetIndex)) inlineMap.set(targetIndex, []);
    inlineMap.get(targetIndex).push(inline);
  }

  const injectAtIndex = new Map();
  const anchorIndices = new Set([...blockMap.keys(), ...lineMap.keys()]);

  const stripTrailingBlankLines = (lineObjects) => {
    if (!Array.isArray(lineObjects)) return lineObjects;
    let end = lineObjects.length;
    while (end > 0) {
      const lineObj = lineObjects[end - 1];
      const text = typeof lineObj === "string"
        ? lineObj
        : lineObj && typeof lineObj.text === "string"
          ? lineObj.text
          : "";
      if (text.trim() === "") {
        end--;
        continue;
      }
      break;
    }
    return lineObjects.slice(0, end);
  };

  const getLineText = (lineObj) => {
    if (typeof lineObj === "string") return lineObj;
    if (lineObj && typeof lineObj.text === "string") return lineObj.text;
    return "";
  };

  for (const anchorIndex of anchorIndices) {
    const blocks = blockMap.get(anchorIndex);
    const lineCommentsAbove = lineMap.get(anchorIndex);
    const injectItems = [];

    if (blocks) {
      for (const block of blocks) {
        const orderIndex = Array.isArray(block.block) && block.block.length > 0
          ? block.block[0].commentedLineIndex
          : block.commentedLineIndex;
        injectItems.push({ kind: "block", orderIndex, comment: block, anchorIndex });
      }
    }

    if (lineCommentsAbove) {
      for (const lineComment of lineCommentsAbove) {
        injectItems.push({
          kind: "line",
          orderIndex: lineComment.commentedLineIndex,
          comment: lineComment,
          anchorIndex,
        });
      }
    }

    injectItems.sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));

    if (injectItems.length === 0) continue;

    let existingBlankBeforeAnchor = 0;
    for (let j = anchorIndex - 1; j >= 0; j--) {
      if (lines[j].trim()) break;
      existingBlankBeforeAnchor += 1;
    }

    let cumulativeAfter = 0;
    for (let idx = injectItems.length - 1; idx >= 0; idx--) {
      const item = injectItems[idx];
      const spacingAfter = Number.isInteger(item.comment.spacingAfter)
        ? item.comment.spacingAfter
        : 0;
      cumulativeAfter += spacingAfter;
      const insertShift = Math.min(existingBlankBeforeAnchor, cumulativeAfter);
      const insertIndex = anchorIndex - insertShift;
      if (!injectAtIndex.has(insertIndex)) {
        injectAtIndex.set(insertIndex, []);
      }
      injectAtIndex.get(insertIndex).push(item);
    }
  }

  // Rebuild the file line by line
  // Iterate through every line of clean code
  // i represents both position in original clean code and potential anchor target for comments.
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block/line comments anchored to this line in original order
    const injectItems = injectAtIndex.get(i);
    if (injectItems) {
      injectItems.sort(
        (a, b) => (a.anchorIndex - b.anchorIndex) || (a.orderIndex || 0) - (b.orderIndex || 0)
      );
    }

    for (let idx = 0; idx < (injectItems || []).length; idx++) {
      const item = injectItems[idx];
      // No-op: spacing is preserved from the source text.

      if (item.kind === "block") {
        const block = item.comment;
        // Inject text_cleanMode (if present and different), then original block.
        const hasTextCleanMode = Array.isArray(block.text_cleanMode);
        const hasBlock = Array.isArray(block.block);
        const cleanModeBlock = stripTrailingBlankLines(block.text_cleanMode);
        const fullBlock = stripTrailingBlankLines(block.block);
        const cleanModeTexts = hasTextCleanMode ? cleanModeBlock.map(getLineText).join("\n") : "";
        const blockTexts = hasBlock ? fullBlock.map(getLineText).join("\n") : "";
        const blocksIdentical = hasTextCleanMode && hasBlock && cleanModeTexts === blockTexts;

        if (hasTextCleanMode && !blocksIdentical) {
          for (const lineObj of cleanModeBlock) {
            pushLine(getLineText(lineObj));
          }
        }
        if (hasBlock) {
          for (const lineObj of fullBlock) {
            pushLine(getLineText(lineObj));
          }
        }
      } else {
        const lineComment = item.comment;
        // Inject text_cleanMode (if present and different), then original line comment.
        const hasTextCleanMode = typeof lineComment.text_cleanMode === "string";
        const hasText = lineComment.text !== undefined;
        const textsIdentical = hasTextCleanMode && hasText && lineComment.text === lineComment.text_cleanMode;

        if (hasTextCleanMode && !textsIdentical) {
          pushLine(lineComment.text_cleanMode);
        }
        if (hasText) {
          pushLine(lineComment.text);
        }
      }
    }

    let line = lines[i];

    const inlines = inlineMap.get(i);
    if (inlines?.length) {
      // If multiple inlines on same line, you probably want to append all.
      // Current behavior: first only (preserving your existing behavior).
      const inline = inlines[0];
      // Combine text (hidden) and text_cleanMode (added in clean mode)
      let commentText = "";
      const hasTextCleanMode = typeof inline.text_cleanMode === "string";
      const textsIdentical = hasTextCleanMode && inline.text === inline.text_cleanMode;

      if (inline.text) {
        commentText += inline.text;
      }
      if (hasTextCleanMode && !textsIdentical) {
        commentText += inline.text_cleanMode;
      }

      if (commentText) {
        line += commentText;
      }
    }
    pushLine(line);
  }

  return result.join("\n");
}

/**
 * Strip ONLY the comments represented by vcmComments from the document text.
 * - Does NOT strip arbitrary syntax comments.
 * - Does NOT need alwaysShow passed in; it ignores alwaysShow internally anyway.
 */
function stripComments(text, filePath, vcmComments = [], options = {}) {
  // Get comment markers for this file type from our centralized config
  const commentMarkers = getCommentMarkersForFile(filePath);
  const lineMarkers = getLineMarkersForFile(filePath);
  const blockMarkers = getBlockMarkersForFile(filePath);
  const lines = text.split("\n");
  const commentOnlyLines = new Set();
  let inBlock = false;
  let blockEnd = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inBlock) {
      commentOnlyLines.add(i);
      const endIdx = line.indexOf(blockEnd);
      if (endIdx >= 0) {
        inBlock = false;
        blockEnd = null;
      }
      continue;
    }

    for (const { start, end } of blockMarkers) {
      const idx = line.indexOf(start);
      if (idx >= 0) {
        const isCommentOnlyStart = line.slice(0, idx).trim().length === 0;
        const endIdx = line.indexOf(end, idx + start.length);
        if (endIdx >= 0) {
          if (isCommentOnlyStart) commentOnlyLines.add(i);
        } else {
          if (isCommentOnlyStart) commentOnlyLines.add(i);
          inBlock = true;
          blockEnd = end;
        }
        break;
      }
    }

    if (!commentOnlyLines.has(i)) {
      for (const marker of lineMarkers) {
        if (trimmed.startsWith(marker)) {
          commentOnlyLines.add(i);
          break;
        }
      }
    }
  }

  // Keys we intend to strip (explicit targets only)
  // alwaysShow is never stripped, ever.
  const alwaysShowTargets = (vcmComments || []).filter((c) => isAlwaysShow(c));
  const stripTargets = (vcmComments || []).filter(
    (c) => !isAlwaysShow(c) && !alwaysShowTargets.some((a) => isSameComment(a, c))
  );
  const inlineLineTargets = new Set(
    stripTargets
      .filter((c) => c.type === "inline")
      .map((c) => c.commentedLineIndex)
      .filter((idx) => typeof idx === "number")
  );
  const usePrimaryMatching = stripTargets.some(
    c => c.isPrivate && c.primaryPrevHash !== undefined
  );
  const stripKeys = usePrimaryMatching
    ? null
    : new Set(stripTargets.map(c => buildContextKey(c)));

  // Nothing to do
  if ((!stripKeys || stripKeys.size === 0) && stripTargets.length === 0) return text;

  // # TODO revisit this for the spacing stuff
  // Extract current comments to identify blank lines within comment blocks
  // Pass vcmComments and mode so blank line extraction works correctly
  const docComments = parseDocComs(text, filePath);
  addPrimaryAnchors(docComments, { lines });

  const getCommentRange = (comment) => {
    if (comment.type === "block" && Array.isArray(comment.block)) {
      const indices = comment.block
        .map((b) => b && b.commentedLineIndex)
        .filter((idx) => typeof idx === "number");
      if (indices.length > 0) {
        return { start: Math.min(...indices), end: Math.max(...indices) };
      }
    }

    if (typeof comment.commentedLineIndex === "number") {
      return { start: comment.commentedLineIndex, end: comment.commentedLineIndex };
    }

    return { start: -1, end: -1 };
  };

  // Track:
  // - Entire lines to remove (block comment lines + blank lines that are part of those parsed blocks)
  // - Inline strips: lineIndex -> commentStartPos (char index where inline comment begins)
  const linesToRemove = new Set();
  const inlineStripAt = new Map(); // lineIndex -> commentStartIdx
  const strippedDocRanges = [];

  for (const current of docComments) {
    if (alwaysShowTargets.some((a) => isSameComment(a, current))) {
      continue;
    }
    let matchesTarget = false;
    if (usePrimaryMatching) {
      matchesTarget = stripTargets.some(t => isSameComment(t, current));
    } else {
      if (
        current.type === "inline" &&
        typeof current.commentedLineIndex === "number" &&
        inlineLineTargets.has(current.commentedLineIndex)
      ) {
        matchesTarget = true;
      } else {
        const key = buildContextKey(current);
        if (stripKeys.has(key)) matchesTarget = true;
      }
    }
    if (!matchesTarget) continue;

    if (current.type === "block" && Array.isArray(current.block)) {
      // Remove only this parsed block's lines (skip blank lines above/below comment stacks)
      for (const b of current.block) {
        const lineIndex = b.commentedLineIndex;
        if (typeof lineIndex !== "number") continue;
        linesToRemove.add(lineIndex);
      }
      strippedDocRanges.push(getCommentRange(current));
      continue;
    }

    if (current.type === "line") {
      // Remove this standalone line comment (spacing only when between comments)
      linesToRemove.add(current.commentedLineIndex);
      strippedDocRanges.push(getCommentRange(current));
      continue;
    }

    if (current.type === "inline") {
      // Remove only the inline segment on that line (keep code portion)
      // Use real marker finder to avoid stripping marker inside strings.
      const lineIndex = current.commentedLineIndex;
      const lineText = lines[lineIndex] ?? "";

      const commentStartIdx = findInlineCommentStart(lineText, commentMarkers, {
        requireWhitespaceBefore: true,
      });

      // Only strip if marker is after some code (inline should have code before)
      if (commentStartIdx > 0 && lineText.slice(0, commentStartIdx).trim()) {
        // If multiple targeted inline comments somehow map to same line, keep earliest strip position
        const existing = inlineStripAt.get(lineIndex);
        if (existing === undefined || commentStartIdx < existing) {
          inlineStripAt.set(lineIndex, commentStartIdx);
        }
      }
    }
  }

  if (strippedDocRanges.length > 1) {
    // Intentionally keep blank lines in place; only comment lines are removed.
  }

  // Apply removals
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    if (linesToRemove.has(i)) continue;

    const stripPos = inlineStripAt.get(i);
    if (stripPos !== undefined) {
      out.push(lines[i].substring(0, stripPos).trimEnd());
    } else {
      out.push(lines[i]);
    }
  }

  return out.join("\n");
}

module.exports = {
  injectComments,
  stripComments,
};
