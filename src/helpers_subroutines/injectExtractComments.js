const { getCommentMarkersForFile } = require("../utils_copycode/commentMarkers");
const { hashLine } = require("../utils_copycode/hash");
const { isolateCodeLine, findInlineCommentStart } = require("../utils_copycode/lineUtils");
const { parseDocComs } = require("../vcm/utils_copycode/parseDocComs");
const { buildContextKey } = require("../utils_copycode/buildContextKey");
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
      commentHash = hashLine(comment.text.trim(), 0);
    } else if (comment.type === "block" && comment.block && comment.block.length > 0) {
      commentHash = hashLine(comment.block[0].text.trim(), 0);
    }

    if (commentHash) {
      // Map this comment's hash to the code line it will be inserted above
      // We'll use the anchor to find the position (will be refined later with actual injection order)
      if (!commentHashToPosition.has(commentHash)) {
        commentHashToPosition.set(commentHash, comment);
      }
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

    // Build a list of possible line indices, each with a “score” indicating how well its context fits.
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
      if (comment.prevHash && prevIdx >= 0) {
        const prevHash = hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0);
        if (prevHash === comment.prevHash) score += 10;
      }

      if (comment.nextHash && nextIdx >= 0) {
        const nextHash = hashLine(isolateCodeLine(lines[nextIdx], commentMarkers), 0);
        if (nextHash === comment.nextHash) score += 10;
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

  const lineComments = commentsToInject.filter(c => c.type === "line").sort((a, b) => (a.commentedLineIndex || 0) - (b.commentedLineIndex || 0));

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
    let anchorHash = null;

    // Use primaryAnchor for private consecutive comments
    if (block.isPrivate && block.primaryAnchor) {
      anchorHash = block.primaryAnchor;
      indices = lineHashToIndices.get(anchorHash);

      if (!indices?.length && existingCommentHashToIndices?.has(anchorHash)) {
        indices = existingCommentHashToIndices.get(anchorHash);
      }

      // If not found in clean text, check if it's a comment being injected
      if (!indices?.length && commentHashToPosition.has(anchorHash)) {
        const targetComment = commentHashToPosition.get(anchorHash);
        // Use the target comment's anchor to find injection position
        indices = lineHashToIndices.get(targetComment.anchor);
      }
    }

    // Fallback to code line anchor
    if (!indices?.length) {
      indices = lineHashToIndices.get(block.anchor);
    }

    if (!indices?.length) continue;

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
    let anchorHash = null;

    // Use primaryAnchor for private consecutive comments
    if (lineComment.isPrivate && lineComment.primaryAnchor) {
      anchorHash = lineComment.primaryAnchor;
      indices = lineHashToIndices.get(anchorHash);

      if (!indices?.length && existingCommentHashToIndices?.has(anchorHash)) {
        indices = existingCommentHashToIndices.get(anchorHash);
      }

      // If not found in clean text, check if it's a comment being injected
      if (!indices?.length && commentHashToPosition.has(anchorHash)) {
        const targetComment = commentHashToPosition.get(anchorHash);
        // Use the target comment's anchor to find injection position
        indices = lineHashToIndices.get(targetComment.anchor);
      }
    }

    // Fallback to code line anchor
    if (!indices?.length) {
      indices = lineHashToIndices.get(lineComment.anchor);
    }

    if (!indices?.length) continue;

    const targetIndex = findBestMatch(lineComment, indices, usedIndices);
    // NOTE: Do NOT add to usedIndices - multiple line comments can share the same anchor

    if (!lineMap.has(targetIndex)) {
      lineMap.set(targetIndex, []);
    }
    lineMap.get(targetIndex).push(lineComment);
  }

  for (const inline of inlineComments) {
    const indices = lineHashToIndices.get(inline.anchor);
    if (!indices?.length) continue;

    const targetIndex = findBestMatch(inline, indices, usedIndices);
    if (!inlineMap.has(targetIndex)) inlineMap.set(targetIndex, []);
    inlineMap.get(targetIndex).push(inline);
  }

  // Rebuild the file line by line
  // Iterate through every line of clean code
  // i represents both position in original clean code and potential anchor target for comments.
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block comments anchored to this line
    // blocks maps anchor index → block comment(s) that should appear above this code line.
    const blocks = blockMap.get(i);
    const lineCommentsAbove = lineMap.get(i);
    // Handle the case of multiple comment blocks anchored to the same code line (stacked).
    if (blocks) {
      for (const block of blocks) {
        // Determine which version to inject: text_cleanMode (if different) or block
        const hasTextCleanMode = Array.isArray(block.text_cleanMode);
        const cleanModeTexts = hasTextCleanMode ? block.text_cleanMode.map(b => b.text).join("\n") : "";
        const blockTexts = Array.isArray(block.block) ? block.block.map(b => b.text).join("\n") : "";
        const blocksIdentical = hasTextCleanMode && Array.isArray(block.block) && cleanModeTexts === blockTexts;

        let linesToInject = [];
        if (hasTextCleanMode && !blocksIdentical) 
          // Use text_cleanMode (newly typed version)
          linesToInject = block.text_cleanMode;
        else if (Array.isArray(block.block)) linesToInject = block.block;

        // Inject all lines from the block (includes leading blanks, comments, and trailing blanks)
        for (const lineObj of linesToInject) {
          result.push(lineObj.text);
        }
      }
    }

    // STEP 2: Insert any line comments anchored to this line
    if (lineCommentsAbove) {
      for (const lineComment of lineCommentsAbove) {
        // Determine which version to inject: text_cleanMode or text
        const hasTextCleanMode = typeof lineComment.text_cleanMode === "string";
        const textsIdentical = hasTextCleanMode && lineComment.text === lineComment.text_cleanMode;

        let textToInject = "";
        if (hasTextCleanMode && !textsIdentical) {
          textToInject = lineComment.text_cleanMode;
        } else if (lineComment.text !== undefined) {
          textToInject = lineComment.text;
        }

        // Always inject, even if blank (preserves spacing within comment groups)
        result.push(textToInject);
      }
    }

    let line = lines[i];

    const inlines = inlineMap.get(i);
    if (inlines?.length) {
      // If multiple inlines on same line, you probably want to append all.
      // Current behavior: first only (preserving your existing behavior).
      const inline = inlines[0];
      // Combine text_cleanMode (string) and text
      let commentText = "";
      const hasTextCleanMode = typeof inline.text_cleanMode === "string";
      const textsIdentical = hasTextCleanMode && inline.text === inline.text_cleanMode;

      if (hasTextCleanMode && !textsIdentical) {
        commentText += inline.text_cleanMode;
      }

      // Add original text (only if no text_cleanMode or they're identical)
      if (inline.text && (!hasTextCleanMode || textsIdentical)) {
        commentText += inline.text;
      }

      if (commentText) {
        line += commentText;
      }
    }
    result.push(line);
  }

  return result.join("\n");
}

/**
 * Strip ONLY the comments represented by vcmComments from the document text.
 * - Does NOT strip arbitrary syntax comments.
 * - Does NOT need alwaysShow passed in; it ignores alwaysShow internally anyway.
 */
function stripComments(text, filePath, vcmComments = []) {
  // Get comment markers for this file type from our centralized config
  const commentMarkers = getCommentMarkersForFile(filePath);

  // Keys we intend to strip (explicit targets only)
  // alwaysShow is never stripped, ever.
  const stripKeys = new Set(
    (vcmComments || [])
      .filter(c => !isAlwaysShow(c))             // never target alwaysShow
      .map(c => buildContextKey(c))              // stable identity
  );

  // Nothing to do
  if (stripKeys.size === 0) return text;

  // # TODO revisit this for the spacing stuff
  // Extract current comments to identify blank lines within comment blocks
  // Pass vcmComments and mode so blank line extraction works correctly
  const docComments = parseDocComs(text, filePath);

  // Track:
  // - Entire lines to remove (block comment lines + blank lines that are part of those parsed blocks)
  // - Inline strips: lineIndex -> commentStartPos (char index where inline comment begins)
  const linesToRemove = new Set();
  const inlineStripAt = new Map(); // lineIndex -> commentStartIdx

  for (const current of docComments) {
    const key = buildContextKey(current);
    if (!stripKeys.has(key)) continue; // this comment is NOT targeted, leave it

    if (current.type === "block" && Array.isArray(current.block)) {
      // Remove only this parsed block's lines (including blanks within the parsed block)
      for (const b of current.block) {
        linesToRemove.add(b.commentedLineIndex);
      }
      continue;
    }

    if (current.type === "line") {
      // Remove this standalone line comment
      linesToRemove.add(current.commentedLineIndex);
      continue;
    }

    if (current.type === "inline") {
      // Remove only the inline segment on that line (keep code portion)
      // Use real marker finder to avoid stripping marker inside strings.
      const lineIndex = current.commentedLineIndex;
      const lineText = text.split("\n")[lineIndex] ?? "";

      const commentStartIdx = findInlineCommentStart(lineText, commentMarkers, {
        requireWhitespaceBefore: true,
      });

      // Only strip if we can locate the marker start
      if (commentStartIdx >= 0) {
        // If multiple targeted inline comments somehow map to same line, keep earliest strip position
        const existing = inlineStripAt.get(lineIndex);
        if (existing === undefined || commentStartIdx < existing) {
          inlineStripAt.set(lineIndex, commentStartIdx);
        }
      }
    }
  }

  // Apply removals
  const lines = text.split("\n");
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
