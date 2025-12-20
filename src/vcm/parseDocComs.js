const { getCommentMarkersForFile } = require("../commentMarkers");
const { hashLine } = require("../hash");
// ===========================================================
// parseDocComs
// ===========================================================
// This builds the raw, current, real-time comment objects extracted from the document
// and generates their anchors / hashes
// type: "inline" or "block"
// exact text + line indices
// anchor, prevHash, nextHash
function parseDocComs(text, filePath) {
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
        commentedLineIndex: i,      // 0-based line index
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
          commentedLineIndex: i, // 0-based line index
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
        commentedLineIndex: i, // the line number it appeared on (changes per mode so not reliable alone)
        text: fullComment,  // Store ALL inline comments as one combined text
      };
      
      inlineComment.anchorText = anchorBase;

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

        blockComment.anchorText = line;

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

      headerComment.anchorText = lines[anchorLine] || "";

    // Insert this block at the beginning of the comments array
    comments.unshift(headerComment);
  }

  return comments;
}

module.exports = {
  parseDocComs,
};