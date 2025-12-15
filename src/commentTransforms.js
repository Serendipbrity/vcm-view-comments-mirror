const { getCommentMarkersForFile } = require("./commentMarkers");
const { hashLine } = require("./hash");

// ===========================================================
// buildVCMObjects
// ===========================================================
// This builds the raw, current, real-time comment objects extracted from the document
// and generates their anchors / hashes
// type: "inline" or "block"
// exact text + line indices
// anchor, prevHash, nextHash
function buildVCMObjects(text, filePath, debugAnchorText = false) {
  const lines = text.split("\n"); // Splits file text into an array of individual lines.
  const comments = [];      // Final array of all extracted comments
  let commentBuffer = [];   // Temporary holding area for consecutive comment lines

  // Get comment markers for this file type from our centralized config list
  const commentMarkers = getCommentMarkersForFile(filePath);

  // Build regex pattern for this file type
  // .replace() escapes special regex characters like *, ?, (, ), etc., because // or % would otherwise break the regex engine.
  // .join('|') means “match any of these markers.”
  // Example:
  // If commentMarkers = ["//", "#"],
  // then markerPattern = "\\/\\/|#" — usable inside new RegExp().
  const markerPattern = commentMarkers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  
  // Helper: Check if a line is a comment or code
  const isComment = (l) => {
    const trimmed = l.trim(); // Remove whitespace
    for (const marker of commentMarkers) { // loop over all possible markers for this file
      // Check whether the line begins with any marker and return true if so
      if (trimmed.startsWith(marker)) return true;
    }
    return false; // not a comment line
  };

  // Helper: Find the next non-blank code line after index i
  const findNextCodeLine = (startIndex) => {
    for (let j = startIndex + 1; j < lines.length; j++) { // Loops forward from the given index.
      const trimmed = lines[j].trim();
      if (trimmed && !isComment(lines[j])) { // Skip blank lines and comments.
        return j; // return code lines index
      }
    }
    return -1; // if none found, return to last line of code's index we found.
  };

  // Helper: Find the previous non-blank code line before index i
  const findPrevCodeLine = (startIndex) => {
    for (let j = startIndex - 1; j >= 0; j--) {
      const trimmed = lines[j].trim();
      if (trimmed && !isComment(lines[j])) {
        return j; // index of next line of code
      }
    }
    return -1; // no code line was found after this point (end of file). So that nextHash becomes null instead of blowing up
  };

  // Process each line sequentially
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // CASE 1: This line is a standalone comment
    if (isComment(line)) {
      // Store the ENTIRE line as-is (includes indent, marker, spacing, text, trailing spaces)
      commentBuffer.push({
        text: line,           // Full line exactly as it appears
        originalLineIndex: i,      // 0-based line index
      });
      continue; // Don’t finalize it yet. move to next line. You might be in the middle of a comment block.
    }

    // CASE 1.5: Currently on Blank line - check if it's within a comment block
    if (!trimmed) { // if no (trimmed) lines
      // If we have comments buffered, this blank line is part of the comment block
      // Include it so spacing is preserved exactly as typed
      if (commentBuffer.length > 0) {
        commentBuffer.push({
          text: line,           // Empty or whitespace-only line
          originalLineIndex: i, // 0-based line index
        });
      }
      // Skip blank lines that are before any comments (they're just file spacing)
      continue;
    }

    // CASE 2: This line is code - check for inline comment(s)
    // Find the first comment marker preceded by white space and extract everything after it as ONE combined comment
    // (\\s+) → one or more whitespace characters
    let inlineRegex = new RegExp(`(\\s+)(${markerPattern})`, "");
    let match = line.match(inlineRegex);

    if (match) {
      const commentStartIndex = match.index; // tells where the comment begins.
      const fullComment = line.substring(commentStartIndex); // extract from that point to the end → the whole inline comment.

      // Context line hashes that are before and after
      const prevIdx = findPrevCodeLine(i);
      const nextIdx = findNextCodeLine(i);

      // Hash only the code portion before the first inline comment marker
      const anchorBase = line.substring(0, commentStartIndex).trimEnd();

      const inlineComment = {
        type: "inline",
        anchor: hashLine(anchorBase, 0), // hash of the line's code (for identification later),
        prevHash: prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null,
        nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
        originalLineIndex: i, // the line number it appeared on (changes per mode so not reliable alone)
        text: fullComment,  // Store ALL inline comments as one combined text
      };

      // Add debug anchor text if enabled
      if (debugAnchorText) {
        inlineComment.anchorText = anchorBase;
      }

      comments.push(inlineComment);
    }

    // CASE 3: We have buffered comment lines (comment group) above this code line
    // Attach the entire comment block to this line of code
    if (commentBuffer.length > 0) {
      // Store context: previous code line and next code line
      const prevIdx = findPrevCodeLine(i);
      const nextIdx = findNextCodeLine(i);

      // DO NOT include leading or trailing blanks - they should persist in clean mode as spacing
      // Only store the actual comment lines (which may include blanks BETWEEN comment lines)
      const fullBlock = commentBuffer;

      const blockComment = {
        type: "block",
        anchor: hashLine(line, 0), // Just content hash
        prevHash: prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null,
        nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
        insertAbove: true, // when re-adding comments, they should appear above that line.
        block: fullBlock,
      };

      // Add debug anchor text if enabled
      if (debugAnchorText) {
        blockComment.anchorText = line;
      }

      comments.push(blockComment);
      commentBuffer = []; // Clear buffer for next block
    }
  }

  // CASE 4: Handle comments at the top of file (before any code)
  // These are typically file headers, copyright notices, or module docstrings
  if (commentBuffer.length > 0) {
    // Find the first actual line of code in the file
    const firstCodeIndex = lines.findIndex((l) => l.trim() && !isComment(l));
    const anchorLine = firstCodeIndex >= 0 ? firstCodeIndex : 0;

    // For file header comments, there's no previous code line
    const nextIdx = findNextCodeLine(anchorLine - 1);

    const headerComment = {
      type: "block",
      anchor: hashLine(lines[anchorLine] || "", 0), // Just content hash
      prevHash: null, // No previous code line before file header
      nextHash: nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null,
      insertAbove: true,
      block: commentBuffer,
    };

    // Add debug anchor text if enabled
    if (debugAnchorText) {
      headerComment.anchorText = lines[anchorLine] || "";
    }

    // Insert this block at the beginning of the comments array
    comments.unshift(headerComment);
  }

  return comments;
}

// -----------------------------------------------------------------------------
// Comment Injection
// -----------------------------------------------------------------------------
// Reconstruct source code by injecting comments back into clean code
// cleanText → the code in clean mode (with comments stripped out).
// comments → parsed metadata previously extracted from the commented version (what you want to re-inject).
// includePrivate → flag to decide whether to re-insert private comments.. Default to privatemode off unless specified to avoid undefined
function injectComments(cleanText, comments, includePrivate = false) {
  // split("\n") turns the code into an array of lines so you can loop by index.
  const lines = cleanText.split("\n");
  const result = [];  // Where you’ll push lines and comments in order, then join back later.

  // Include/exclude private comments based on if includePrivate is toggled on or off
  const commentsToInject = comments.filter(c => {
    if (c.alwaysShow) return false; // Always exclude alwaysShow so no. double injection because they were never removed
    if (c.isPrivate && !includePrivate) return false; // Exclude private if not explicitly included
    return true;
  });

  // Create an empty Map to link each line’s unique hash → all positions in the file where that line exists. 
  // (handles duplicates)
  // You use a Map instead of an object because the keys (hash strings) are not simple variable names and you may have duplicates.
  const lineHashToIndices = new Map();
  for (let i = 0; i < lines.length; i++) { // Iterates through every line.
    // Remove whitespace per line and if the result is empty (meaning blank line), it skips it. You don’t hash blank lines because they’re not meaningful anchors for comments.
    if (lines[i].trim()) { 
      // Hash each unique content line
      // Takes the current line’s code content (not line number) and generates a deterministic hash.
      // Hashes let you re-anchor comments even if the code is moved up or down because you can later match by the same hash.
      const hash = hashLine(lines[i], 0); 
      if (!lineHashToIndices.has(hash)) { // If this hash hasn’t been seen before
        lineHashToIndices.set(hash, []); // Create a new list as its value in the map.
      }
      // Add the current line’s index to that hash’s list
      // This allows for duplicate code lines:
      // If the same text appears twice (say, import torch on lines 3 and 20),
      // the map will have: "hash(import torch)" → [3, 20]
      // So later you can decide which one the comment should attach to.
      lineHashToIndices.get(hash).push(i);
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

      // Compare these neighbor lines to the comment’s stored hashes and score based on matching context
      // Add 10 points for each matching context hash.
      // Higher score = better contextual fit.
      if (comment.prevHash && prevIdx >= 0) {
        const prevHash = hashLine(lines[prevIdx], 0);
        if (prevHash === comment.prevHash) score += 10;
      }

      if (comment.nextHash && nextIdx >= 0) {
        const nextHash = hashLine(lines[nextIdx], 0);
        if (nextHash === comment.nextHash) score += 10;
      }

      return { idx, score };
    });

    // Sort by score (highest first), then by index (to maintain order)
    scores.sort((a, b) => {
      // Sort by score descending
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx; // sort and return index by index ascending.
    });

    return scores[0].idx; // Return the index with highest contextual match.
  };

  // Separate block comments by type and sort by originalLineIndex
  // Ensure that when you loop through comments, they’re in natural file order, not random JSON order.
  // .sort(...) orders the comment blocks from top to bottom according to where they originally appeared by line number in the file.
  // That way, when you inject them, they’re added in the same vertical order they were extracted.
  const blockComments = commentsToInject.filter(c => c.type === "block").sort((a, b) => {
    // Each block comment object has a block array. each el = 1 comment line of the block
    // a.block[0]?.originalLineIndex → accesses the first line of that block (top of the comment) and gets its original line number in the old file.
    // The ?. (optional chaining) avoids errors if block or [0] doesn’t exist (so it returns undefined instead of crashing).
    // || 0 = “if we can’t find its original position, assume line 0.”
    const aLine = a.block[0]?.originalLineIndex || 0; 
    const bLine = b.block[0]?.originalLineIndex || 0;
    return aLine - bLine; // sort them ascending (smallest line number - top of file first).
  });
  const inlineComments = commentsToInject.filter(c => c.type === "inline").sort((a, b) => a.originalLineIndex - b.originalLineIndex);

  // Track which indices we've already used
  const usedIndices = new Set();

  // Build maps: Map() is a key-value store where keys can be any type.
  // key = line index of code
  // value = array of block comment objects that attach to that code line.
  // This is what injectComments() uses later to decide “for line i, which comments go above it?”
  const blockMap = new Map();

  // Loops through every block comment that needs to be inserted.
  for (const block of blockComments) {
    // indices is an array of potential candidate line numbers where that code exists now.
    // lineHashToIndices maps a hash of a code line → all possible line indices in the current document that match that code’s hash.
    // block.anchor is that hash value — it’s how we know which code line this comment originally belonged to.
    const indices = lineHashToIndices.get(block.anchor);
    // Only proceed if the anchor’s code still exists in the file (non-null and non-empty array).
    if (indices && indices.length > 0) {
      // findBestMatch() decides which of those possible indices best matches this comment.
      // Example: if that same code line appears twice in the file, it picks the one nearest to where the comment used to be.
      // It also receives usedIndices to avoid assigning a block to an index already taken.
      const targetIndex = findBestMatch(block, indices, usedIndices);
      usedIndices.add(targetIndex); // Adds the target index to usedIndices (taken) so you don’t double-assign it.

      // if the map doesnt exist yet for this index
      if (!blockMap.has(targetIndex)) {
        // initialize an empty array for it
        blockMap.set(targetIndex, []);
      }
      // Actually stores the comment object(s) in that array — meaning:
      // “When reinjecting, for this line index, insert this block comment above it.”
      blockMap.get(targetIndex).push(block);
    }
  }

  // Same logic as blockMap, but this one tracks inline comments.
  // Key = line index of code line, value = array of inline comments that go on that line.
  const inlineMap = new Map();
  for (const inline of inlineComments) {
    const indices = lineHashToIndices.get(inline.anchor);
    if (indices && indices.length > 0) {
      const targetIndex = findBestMatch(inline, indices, usedIndices);
      // DON'T mark as used for inline comments - multiple inlines can be on same line!
      // usedIndices.add(targetIndex);

      if (!inlineMap.has(targetIndex)) inlineMap.set(targetIndex, []);
      inlineMap.get(targetIndex).push(inline);
    }
  }

  // Rebuild the file line by line
  // Iterate through every line of clean code
  // i represents both position in original clean code and potential anchor target for comments.
  for (let i = 0; i < lines.length; i++) {
    // STEP 1: Insert any block comments anchored to this line
    // blocks maps anchor index → block comment(s) that should appear above this code line.
    const blocks = blockMap.get(i);
    // Handle the case of multiple comment blocks anchored to the same code line (stacked).
    if (blocks) {
      for (const block of blocks) {
        // Determine which version to inject: text_cleanMode (if different) or block
        const hasTextCleanMode = block.text_cleanMode && Array.isArray(block.text_cleanMode);
        const cleanModeTexts = hasTextCleanMode ? block.text_cleanMode.map(b => b.text).join('\n') : '';
        const blockTexts = block.block ? block.block.map(b => b.text).join('\n') : '';
        const blocksIdentical = hasTextCleanMode && block.block && cleanModeTexts === blockTexts;

        let linesToInject;
        if (hasTextCleanMode && !blocksIdentical) {
          // Use text_cleanMode (newly typed version)
          linesToInject = block.text_cleanMode;
        } else if (block.block) {
          // Use block (VCM version or identical)
          linesToInject = block.block;
        } else {
          linesToInject = [];
        }

        // Inject all lines from the block (includes leading blanks, comments, and trailing blanks)
        for (const lineObj of linesToInject) {
          result.push(lineObj.text);
        }
      }
    }

    // STEP 2: Add the code line itself
    let line = lines[i];

    // STEP 3: Check if this line has an inline comment
    const inlines = inlineMap.get(i);
    if (inlines && inlines.length > 0) {
      // Should only be one inline comment per line (contains all combined comments)
      const inline = inlines[0];
      // Combine text_cleanMode (string) and text
      let commentText = "";

      // Only use text_cleanMode if it's different from text (avoid double injection)
      const hasTextCleanMode = inline.text_cleanMode && typeof inline.text_cleanMode === 'string';
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

// Remove all comments from source code, leaving only code and blank lines
// This creates the "clean" version for split view or toggle mode
// Process:
// 1. Filter out lines that are pure comments (start with #, //, etc)
// 2. Strip inline comments from mixed code+comment lines
// 3. Preserve blank lines to maintain code structure
// 4. Handle strings properly - don't remove comment markers inside strings
// 5. Language-aware: only remove markers appropriate for the file type
// 6. Skip comments marked with alwaysShow flag (they appear in all modes)
function stripComments(text, filePath, vcmComments = [], keepPrivate = false, isCleanMode = false) {
  // Get comment markers for this file type from our centralized config
  const commentMarkers = getCommentMarkersForFile(filePath);

  // Build regex pattern for this file type
  const markerPattern = commentMarkers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const lineStartPattern = new RegExp(`^(${markerPattern})`);

  // Helper: Find the position of an inline comment, accounting for strings
  const findCommentStart = (line) => {
    let inString = false;
    let stringChar = null;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      // Handle escape sequences
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }

      // Track string state (single, double, or backtick quotes)
      if (!inString && (char === '"' || char === "'" || char === '`')) {
        inString = true;
        stringChar = char;
        continue;
      }
      if (inString && char === stringChar) {
        inString = false;
        stringChar = null;
        continue;
      }

      // Only look for comment markers outside of strings
      if (!inString) {
        // Check each marker for this language
        for (const marker of commentMarkers) {
          if (marker.length === 2) {
            // Two-character markers like //, --, etc.
            if (char === marker[0] && nextChar === marker[1]) {
              // Make sure there's whitespace before it (not part of code)
              if (i > 0 && line[i - 1].match(/\s/)) {
                return i - 1; // Include the whitespace
              }
            }
          } else {
            // Single-character markers like #, %, ;
            if (char === marker) {
              // Make sure there's whitespace before it
              if (i > 0 && line[i - 1].match(/\s/)) {
                return i - 1;
              }
            }
          }
        }
      }
    }

    return -1; // No comment found
  };

  // Build sets of comment anchor hashes that should be kept
  const alwaysShowAnchors = new Set();
  const privateAnchors = new Set();
  for (const comment of vcmComments) {
    if (comment.alwaysShow) {
      alwaysShowAnchors.add(comment.anchor);
    }
    if (comment.isPrivate && keepPrivate) {
      privateAnchors.add(comment.anchor);
    }
  }

  // # TODO revisit this for the spacing stuff
  // Extract current comments to identify blank lines within comment blocks
  // Pass vcmComments and mode so blank line extraction works correctly
  const docComments = buildVCMObjects(text, filePath, vcmComments, isCleanMode);

  // Build sets for tracking lines
  const allCommentBlockLines = new Set();
  const alwaysShowLines = new Set();
  const alwaysShowInlineComments = new Map();
  const privateLines = new Set();
  const privateInlineComments = new Map();

  for (const current of docComments) {
    if (current.type === "block" && current.block) {
      // Track all lines in all comment blocks (including blank lines WITHIN them)
      // But DO NOT track leading/trailing blank lines - those should stay visible in ALL modes
      for (const blockLine of current.block) {
        allCommentBlockLines.add(blockLine.originalLineIndex);
      }

      // If this block is alwaysShow, also add to alwaysShow set
      if (alwaysShowAnchors.has(current.anchor)) {
        for (const blockLine of current.block) {
          alwaysShowLines.add(blockLine.originalLineIndex);
        }
      }

      // If this block is private and we're keeping private, add to private set
      if (privateAnchors.has(current.anchor)) {
        for (const blockLine of current.block) {
          privateLines.add(blockLine.originalLineIndex);
        }
      }
    } else if (current.type === "inline") {
      if (alwaysShowAnchors.has(current.anchor)) {
        // For alwaysShow inline comments, store the line index and text
        alwaysShowLines.add(current.originalLineIndex);
        alwaysShowInlineComments.set(current.originalLineIndex, current.text || "");
      }
      if (privateAnchors.has(current.anchor)) {
        // For private inline comments (if keeping), store the line index and text
        privateLines.add(current.originalLineIndex);
        privateInlineComments.set(current.originalLineIndex, current.text || "");
      }
    }
  }

  // Combine alwaysShow and private into comment maps for inline handling
  const inlineCommentsToKeep = new Map([...alwaysShowInlineComments, ...privateInlineComments]);

  const lines = text.split("\n");
  const filteredLines = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    // Keep lines that are marked as alwaysShow or private (if keeping private)
    if (alwaysShowLines.has(lineIndex) || privateLines.has(lineIndex)) {
      filteredLines.push(line);
      continue;
    }

    // Keep blank lines UNLESS they're part of a comment block (i.e., blank lines BETWEEN comment lines)
    // Blank lines before/after comments should ALWAYS be kept
    if (!trimmed) {
      if (!allCommentBlockLines.has(lineIndex)) {
        filteredLines.push(line);
      }
      continue;
    }

    // Filter out pure comment lines (unless they're alwaysShow or private)
    if (lineStartPattern.test(trimmed)) {
      continue; // Skip this line
    }

    // This is a code line - check for inline comments
    if (inlineCommentsToKeep.has(lineIndex)) {
      // This line has an alwaysShow or private inline comment - keep the entire line
      filteredLines.push(line);
    } else {
      // Remove inline comments: everything after comment marker (if not in string)
      const commentPos = findCommentStart(line);
      if (commentPos >= 0) {
        filteredLines.push(line.substring(0, commentPos).trimEnd());
      } else {
        filteredLines.push(line);
      }
    }
  }

  return filteredLines.join("\n");
}

module.exports = {
  buildVCMObjects,
  injectComments,
  stripComments,
};
