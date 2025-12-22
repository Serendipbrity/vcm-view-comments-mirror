const { findInlineCommentStart, isolateCodeLine, findPrevNextCodeLine } = require("../lineUtils");
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
  
  // Helper: Check if a line is a comment or code
  const isComment = (l) => {
    const trimmed = (l || "").trim();
 // Remove whitespace
    for (const marker of commentMarkers) { // loop over all possible markers for this file
      // Check whether the line begins with any marker and return true if so
      if (trimmed.startsWith(marker)) return true;
    }
    return false; // not a comment line
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

    // Inline comment detection on a code line
    const commentStartIndex = findInlineCommentStart(line, commentMarkers, { requireWhitespaceBefore: true });

    if (commentStartIndex >= 0) {
      const fullComment = line.substring(commentStartIndex); // extract from that point to the end → the whole inline comment.

      const { prevIdx, nextIdx } = findPrevNextCodeLine(i, lines, isComment);

      const prevHash =
        prevIdx >= 0 ? hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0) : null;

      const nextHash =
        nextIdx >= 0 ? hashLine(isolateCodeLine(lines[nextIdx], commentMarkers), 0) : null;

      const anchorText = isolateCodeLine(line, commentMarkers);
      // Hash only the code portion before the first inline comment marker
      const anchorBase = hashLine(anchorText, 0);

      comments.push({
        type: "inline",
        anchor: anchorBase, // hash of the line's code (for identification later),
        prevHash,
        nextHash,
        commentedLineIndex: i,      // 0-based line index
        text: fullComment,  // Store ALL inline comments as one combined text
        anchorText,
      });
    }

    // CASE 3: We have buffered comment lines (comment group) above this code line
    // Attach the entire comment block to this line of code
    if (commentBuffer.length > 0) {
      const { prevIdx, nextIdx } = findPrevNextCodeLine(i, lines, isComment);

      const prevHash =
        prevIdx >= 0 ? hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0) : null;

      const nextHash =
        nextIdx >= 0 ? hashLine(isolateCodeLine(lines[nextIdx], commentMarkers), 0) : null;

      const anchorText = isolateCodeLine(line, commentMarkers);
      // Hash only the code portion before the first inline comment marker
      const anchorBase = hashLine(anchorText, 0);

      comments.push({
        type: "block",
        anchor: anchorBase, // Just content hash
        prevHash,
        nextHash,
        insertAbove: true, // when re-adding comments, they should appear above that line.
        block: commentBuffer,
        anchorText,
      });

      commentBuffer = []; // Clear buffer for next block
    }
  }

  // Header comment block (comment-only lines at EOF or before any code)
  if (commentBuffer.length > 0) {
    // Find the first actual line of code in the file
    const firstCodeIndex = lines.findIndex((l) => l.trim() && !isComment(l));
    const anchorLine = firstCodeIndex >= 0 ? firstCodeIndex : 0;

    // Use anchorLine-1 so "next" resolves to the first code line
    const { nextIdx } = findPrevNextCodeLine(anchorLine - 1, lines, isComment);

    const nextHash =
      nextIdx >= 0 ? hashLine(isolateCodeLine(lines[nextIdx], commentMarkers), 0) : null;

    const anchorText = isolateCodeLine(lines[anchorLine] || "", commentMarkers);

    // Hash only the code portion before the first inline comment marker
    const anchorBase = hashLine(anchorText, 0);

    const headerComment = {
      type: "block",
      anchor: anchorBase,
      prevHash: null, // No previous code line before file header
      nextHash,
      insertAbove: true,
      block: commentBuffer,
      anchorText,
    };
    // Insert this block at the beginning of the comments array
    comments.unshift(headerComment);
  }

  return comments;
}

module.exports = { parseDocComs };
