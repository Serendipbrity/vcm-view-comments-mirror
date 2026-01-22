const { findInlineCommentStart, isolateCodeLine, findPrevNextCodeLine } = require("../../utils_copycode/lineUtils");
const { getCommentMarkersForFile, getLineMarkersForFile, getBlockMarkersForFile } = require("../../utils_copycode/commentMarkers");
const { hashLine } = require("../../utils_copycode/hash");
const { getCommentText } = require("../../utils_copycode/getCommentText");
const { buildContextKey } = require("../../utils_copycode/buildContextKey");
// ===========================================================
// parseDocComs
// ===========================================================
// This builds the raw, current, real-time comment objects extracted from the document
// and generates their anchors / hashes
// type: "inline", "line", or "block"
// exact text + line indices
// anchor, prevHash, nextHash
function parseDocComs(text, filePath) {
  const lines = text.split("\n");
  const comments = [];
  let lineCommentBuffer = [];   // Buffer for consecutive line comments (will emit individually)
  let insideBlockComment = false;
  let blockCommentBuffer = [];
  let blockCommentStartMarker = null;
  let blockCommentEndMarker = null;

  const lineMarkers = getLineMarkersForFile(filePath);
  const blockMarkers = getBlockMarkersForFile(filePath);
  const commentMarkers = getCommentMarkersForFile(filePath);

  // PASS 1: Build a set of all comment-only line indices (line comments + block comment lines)
  const commentOnlyLines = new Set();
  let inBlock = false;
  let blockEnd = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if inside block comment
    if (inBlock) {
      commentOnlyLines.add(i);
      const endIdx = line.indexOf(blockEnd);
      if (endIdx >= 0) {
        inBlock = false;
        blockEnd = null;
      }
      continue;
    }

    // Check if block comment starts
    for (const { start, end } of blockMarkers) {
      const idx = line.indexOf(start);
      if (idx >= 0) {
        const isCommentOnlyStart = line.slice(0, idx).trim().length === 0;
        const endIdx = line.indexOf(end, idx + start.length);
        if (endIdx >= 0) {
          // One-line block
          if (isCommentOnlyStart) commentOnlyLines.add(i);
        } else {
          // Multi-line block starts
          if (isCommentOnlyStart) commentOnlyLines.add(i);
          inBlock = true;
          blockEnd = end;
        }
        break;
      }
    }

    // Check if line comment (but not if already marked as block)
    if (!commentOnlyLines.has(i)) {
      for (const marker of lineMarkers) {
        if (trimmed.startsWith(marker)) {
          commentOnlyLines.add(i);
          break;
        }
      }
    }
  }

  // Helper: Check if a line starts with a line comment marker
  const isLineComment = (l) => {
    const trimmed = (l || "").trim();
    for (const marker of lineMarkers) {
      if (trimmed.startsWith(marker)) return true;
    }
    return false;
  };

  // Helper: Check if we're entering a block comment on this line
  const findBlockCommentStart = (l, startIdx = 0) => {
    for (const { start, end } of blockMarkers) {
      const idx = l.indexOf(start, startIdx);
      if (idx >= 0) {
        return { idx, start, end };
      }
    }
    return null;
  };

  // Helper: Check if we're exiting a block comment on this line
  const findBlockCommentEnd = (l, endMarker, startIdx = 0) => {
    const idx = l.indexOf(endMarker, startIdx);
    return idx >= 0 ? idx : -1;
  };

  // Helper: Predicate for findPrevNextCodeLine - returns true if line is comment-only
  const isCommentOnlyLine = (l, idx) => commentOnlyLines.has(idx);

  // Helper: Emit buffered line comments as individual type:"line" objects
  const flushLineComments = (anchorLineIdx) => {
    if (lineCommentBuffer.length === 0) return;

    for (const lineObj of lineCommentBuffer) {
      const { prevIdx } = findPrevNextCodeLine(lineObj.commentedLineIndex, lines, (l, idx) =>
        isCommentOnlyLine(l, idx)
      );

      const prevHash = prevIdx >= 0 ? hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0) : null;
      const prevHashText = prevIdx >= 0 ? isolateCodeLine(lines[prevIdx], commentMarkers) : "";

      const anchorText = anchorLineIdx >= 0 && anchorLineIdx < lines.length
        ? isolateCodeLine(lines[anchorLineIdx], commentMarkers)
        : "";
      const anchorBase = hashLine(anchorText, 0);
      const { nextIdx: nextAfterAnchorIdx } = anchorLineIdx >= 0
        ? findPrevNextCodeLine(anchorLineIdx, lines, (l, idx) => isCommentOnlyLine(l, idx))
        : { nextIdx: -1 };
      const nextHash = nextAfterAnchorIdx >= 0
        ? hashLine(isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers), 0)
        : null;
      const nextHashText = nextAfterAnchorIdx >= 0 ? isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers) : "";

      comments.push({
        type: "line",
        prevHash,
        anchor: anchorBase,
        nextHash,
        prevHashText,
        text: lineObj.text,
        anchorText,
        nextHashText,
        commentedLineIndex: lineObj.commentedLineIndex,
        insertAbove: true,
      });
    }

    lineCommentBuffer = [];
  };

  // Process each line sequentially
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // CASE 1: Inside a delimited block comment
    if (insideBlockComment) {
      const endIdx = findBlockCommentEnd(line, blockCommentEndMarker);

      if (endIdx >= 0) {
        // Block comment ends on this line
        blockCommentBuffer.push({
          text: line,
          commentedLineIndex: i,
        });

        // Emit the complete block comment
        const { prevIdx } = findPrevNextCodeLine(
          blockCommentBuffer[0].commentedLineIndex,
          lines,
          (l, idx) => isCommentOnlyLine(l, idx)
        );

        const prevHash = prevIdx >= 0 ? hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0) : null;
        const prevHashText = prevIdx >= 0 ? isolateCodeLine(lines[prevIdx], commentMarkers) : "";

        // Find next code line for anchor
        let anchorLineIdx = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() && !commentOnlyLines.has(j)) {
            anchorLineIdx = j;
            break;
          }
        }

        const anchorText = anchorLineIdx >= 0 ? isolateCodeLine(lines[anchorLineIdx], commentMarkers) : "";
        const anchorBase = hashLine(anchorText, 0);
        const { nextIdx: nextAfterAnchorIdx } = anchorLineIdx >= 0
          ? findPrevNextCodeLine(anchorLineIdx, lines, (l, idx) => isCommentOnlyLine(l, idx))
          : { nextIdx: -1 };
        const nextHash = nextAfterAnchorIdx >= 0
          ? hashLine(isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers), 0)
          : null;
        const nextHashText = nextAfterAnchorIdx >= 0 ? isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers) : "";

        // If this is a header comment (prevHash is null), include trailing blank lines
        // This preserves spacing after header comments at the start of the file
        const isHeaderComment = prevHash === null;
        if (isHeaderComment) {
          // Check for blank lines immediately after this block comment
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].trim()) {
              // Blank line - include it in the block
              blockCommentBuffer.push({
                text: lines[j],
                commentedLineIndex: j,
              });
            } else {
              // Hit non-blank line, stop
              break;
            }
          }
        } else {
          let nextNonBlankIdx = -1;
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim()) {
              nextNonBlankIdx = j;
              break;
            }
          }
          if (nextNonBlankIdx >= 0 && commentOnlyLines.has(nextNonBlankIdx)) {
            for (let j = i + 1; j < nextNonBlankIdx; j++) {
              if (!lines[j].trim()) {
                blockCommentBuffer.push({
                  text: lines[j],
                  commentedLineIndex: j,
                });
              }
            }
          }
        }

        comments.push({
          type: "block",
          prevHash,
          anchor: anchorBase,
          nextHash,
          insertAbove: true,
          block: blockCommentBuffer,
          anchorText,
          nextHashText,
          insertAbove: true,
        });

        blockCommentBuffer = [];
        insideBlockComment = false;
        blockCommentStartMarker = null;
        blockCommentEndMarker = null;
        continue;
      } else {
        // Still inside block, continue buffering
        blockCommentBuffer.push({
          text: line,
          commentedLineIndex: i,
        });
        continue;
      }
    }

    // CASE 2: Check if a delimited block comment starts on this line
    const blockStart = findBlockCommentStart(line);
    if (blockStart && blockStart.idx === line.indexOf(blockStart.start)) {
      // Flush any pending line comments first
      flushLineComments(i);

      // Check if block comment also ends on the same line
      const endIdx = findBlockCommentEnd(line, blockStart.end, blockStart.idx + blockStart.start.length);

      if (endIdx >= 0) {
        // One-line block comment
        const { prevIdx } = findPrevNextCodeLine(i, lines, (l, idx) => isCommentOnlyLine(l, idx));

        const prevHash = prevIdx >= 0 ? hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0) : null;
        const prevHashText = prevIdx >= 0 ? isolateCodeLine(lines[prevIdx], commentMarkers) : "";

        let anchorLineIdx = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() && !commentOnlyLines.has(j)) {
            anchorLineIdx = j;
            break;
          }
        }

        const anchorText = anchorLineIdx >= 0 ? isolateCodeLine(lines[anchorLineIdx], commentMarkers) : "";
        const anchorBase = hashLine(anchorText, 0);
        const { nextIdx: nextAfterAnchorIdx } = anchorLineIdx >= 0
          ? findPrevNextCodeLine(anchorLineIdx, lines, (l, idx) => isCommentOnlyLine(l, idx))
          : { nextIdx: -1 };
        const nextHash = nextAfterAnchorIdx >= 0
          ? hashLine(isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers), 0)
          : null;
        const nextHashText = nextAfterAnchorIdx >= 0 ? isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers) : "";

        // Build the block array
        const blockArray = [{ text: line, commentedLineIndex: i }];

        // If this is a header comment (prevHash is null), include trailing blank lines
        const isHeaderComment = prevHash === null;
        if (isHeaderComment) {
          for (let j = i + 1; j < lines.length; j++) {
            if (!lines[j].trim()) {
              blockArray.push({
                text: lines[j],
                commentedLineIndex: j,
              });
            } else {
              break;
            }
          }
        } else {
          let nextNonBlankIdx = -1;
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j].trim()) {
              nextNonBlankIdx = j;
              break;
            }
          }
          if (nextNonBlankIdx >= 0 && commentOnlyLines.has(nextNonBlankIdx)) {
            for (let j = i + 1; j < nextNonBlankIdx; j++) {
              if (!lines[j].trim()) {
                blockArray.push({
                  text: lines[j],
                  commentedLineIndex: j,
                });
              }
            }
          }
        }

        comments.push({
          type: "block",
          prevHash,
          anchor: anchorBase,
          nextHash,
          prevHashText,
          block: blockArray,
          anchorText,
          nextHashText,
          insertAbove: true,
        });
        continue;
      } else {
        // Multi-line block comment starts here
        insideBlockComment = true;
        blockCommentStartMarker = blockStart.start;
        blockCommentEndMarker = blockStart.end;
        blockCommentBuffer = [{ text: line, commentedLineIndex: i }];
        continue;
      }
    }

    // CASE 3: This line is a standalone line comment
    if (isLineComment(line)) {
      lineCommentBuffer.push({
        text: line,
        commentedLineIndex: i,
      });
      continue;
    }

    // CASE 4: Blank line - check if it's within a line comment group
    if (!trimmed) {
      if (lineCommentBuffer.length > 0) {
        lineCommentBuffer.push({
          text: line,
          commentedLineIndex: i,
        });
      }
      continue;
    }

    // CASE 5: Code line - check for inline comment
    const commentStartIndex = findInlineCommentStart(line, commentMarkers, { requireWhitespaceBefore: true });

    if (commentStartIndex >= 0) {
      // Flush any pending line comments first
      flushLineComments(i);

      const fullComment = line.substring(commentStartIndex);

      const { prevIdx } = findPrevNextCodeLine(i, lines, (l, idx) => isCommentOnlyLine(l, idx));

      const prevHash = prevIdx >= 0 ? hashLine(isolateCodeLine(lines[prevIdx], commentMarkers), 0) : null;
      const prevHashText = prevIdx >= 0 ? isolateCodeLine(lines[prevIdx], commentMarkers) : "";

      const anchorText = isolateCodeLine(line, commentMarkers);
      const anchorBase = hashLine(anchorText, 0);
      const { nextIdx: nextAfterAnchorIdx } = findPrevNextCodeLine(i, lines, (l, idx) =>
        isCommentOnlyLine(l, idx)
      );
      const nextHash = nextAfterAnchorIdx >= 0
        ? hashLine(isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers), 0)
        : null;
      const nextHashText = nextAfterAnchorIdx >= 0 ? isolateCodeLine(lines[nextAfterAnchorIdx], commentMarkers) : "";

      comments.push({
        type: "inline",
        anchor: anchorBase,
        prevHash,
        nextHash,
        prevHashText,
        text: fullComment,
        anchorText,
        nextHashText,
        commentedLineIndex: i,
      });
    } else {
      // Code line with no inline comment - flush pending line comments
      flushLineComments(i);
    }
  }

  // Handle remaining buffered line comments at EOF
  if (lineCommentBuffer.length > 0) {
    const firstCodeIndex = lines.findIndex((l) => l.trim() && !isLineComment(l));
    flushLineComments(firstCodeIndex >= 0 ? firstCodeIndex : 0);
  }

  return comments;
}

function enrichWithConsecutiveAnchors(comments, privateKeys, privateTextSet) {
  // Helper: Get comment identity text for hashing (mirrors isolateCodeLine for code)
  // Why use full block text: two blocks with identical first lines but different content
  // must have different identities to avoid hash collisions in comment-to-comment anchoring
  const getCommentIdentityText = (c) => getCommentText(c) || "";
  const getCommentFirstLineText = (c) => {
    if (c.type === "block") {
      const blockArray = c.block || c.text_cleanMode;
      if (Array.isArray(blockArray) && blockArray.length > 0) {
        for (const line of blockArray) {
          const text = typeof line === "string" ? line : (line.text || "");
          if (text.trim()) return text;
        }
      }
    }
    if (c.type === "line") {
      const text = c.text || c.text_cleanMode || "";
      return text.trim() ? text : "";
    }
    const text = getCommentIdentityText(c);
    if (!text) return "";
    return text.split("\n")[0];
  };
  const getLineAfterCommentFirstLine = (c) => {
    if (c.type === "block") {
      const blockArray = c.block || c.text_cleanMode;
      if (Array.isArray(blockArray) && blockArray.length > 1) {
        let foundFirst = false;
        for (const line of blockArray) {
          const text = typeof line === "string" ? line : (line.text || "");
          if (!text.trim()) continue;
          if (!foundFirst) {
            foundFirst = true;
            continue;
          }
          return text;
        }
      }
    }
    return "";
  };
  const getCommentLastLineText = (c) => {
    if (c.type === "block") {
      const blockArray = c.block || c.text_cleanMode;
      if (Array.isArray(blockArray) && blockArray.length > 0) {
        for (let i = blockArray.length - 1; i >= 0; i--) {
          const line = blockArray[i];
          const text = typeof line === "string" ? line : (line.text || "");
          if (text.trim()) return text;
        }
      }
    }
    if (c.type === "line") {
      const text = c.text || c.text_cleanMode || "";
      return text.trim() ? text : "";
    }
    const text = getCommentIdentityText(c);
    if (!text) return "";
    const lines = text.split("\n");
    return lines[lines.length - 1];
  };

  // Helper: Get readable text version (for *Text fields)
  const getCommentReadableText = (c) => {
    if (c.type === "line") return c.text.trim();
    if (c.type === "block" && c.block && c.block.length > 0) {
      return c.block[0].text.trim();
    }
    return "";
  };

  // Step 1: Group comments into consecutive stacks by document contiguity
  // Why base anchor alone is insufficient: comments with same anchor may not be contiguous
  // (e.g., two comment groups separated by code but anchoring to the same later line).
  // We need contiguous regions to correctly model comment-to-comment relationships.
  const stacks = [];
  let currentStack = [];

  const lineBlockComments = comments.filter(c =>
    (c.type === "block") || (c.type === "line" && (c.text || c.text_cleanMode || "").trim())
  );

  for (let i = 0; i < lineBlockComments.length; i++) {
    const comment = lineBlockComments[i];

    if (currentStack.length === 0) {
      currentStack.push(comment);
    } else {
      const prevComment = currentStack[currentStack.length - 1];

      // Comments are contiguous if they share the same anchor AND are adjacent in the array
      // (parseDocComs already outputs comments in document order, so adjacency = contiguity)
      const sameAnchor = comment.anchor === prevComment.anchor;

      if (sameAnchor) {
        currentStack.push(comment);
      } else {
        if (currentStack.length > 0) {
          stacks.push(currentStack);
        }
        currentStack = [comment];
      }
    }
  }
  if (currentStack.length > 0) {
    stacks.push(currentStack);
  }

  // Step 2: Process each stack
  for (const stack of stacks) {
    // Only enrich if stack has multiple comments (consecutive)
    if (stack.length <= 1) continue;

    // Process each comment in the stack
    for (let i = 0; i < stack.length; i++) {
      const comment = stack[i];
      const commentText = getCommentText(comment);
      const commentIsPrivate = privateTextSet
        ? (commentText && privateTextSet.has(commentText))
        : (privateKeys && privateKeys.has(buildContextKey(comment)));

      if (commentIsPrivate) {
        // PRIMARY CHAIN: private comments in a consecutive stack (mirrors base prev/next logic)
        const primaryPrevComment = i > 0 ? stack[i - 1] : null;
        const primaryNextComment = i < stack.length - 1 ? stack[i + 1] : null;

        if (primaryPrevComment) {
          const identityText = getCommentLastLineText(primaryPrevComment);
          comment.primaryPrevHash = hashLine(identityText, 0);
          comment.primaryPrevHashText = getCommentLastLineText(primaryPrevComment);
        } else {
          comment.primaryPrevHash = comment.prevHash;
          comment.primaryPrevHashText = "";
        }

        let primaryNextAfterAnchor = null;
        let primaryNextAfterAnchorLine = "";
        if (primaryNextComment) {
          primaryNextAfterAnchorLine = getLineAfterCommentFirstLine(primaryNextComment);
          if (!primaryNextAfterAnchorLine) {
            primaryNextAfterAnchor = i + 2 < stack.length ? stack[i + 2] : null;
          }
        }

        if (primaryNextAfterAnchorLine) {
          comment.primaryNextHash = hashLine(primaryNextAfterAnchorLine, 0);
          comment.primaryNextHashText = primaryNextAfterAnchorLine;
        } else if (primaryNextAfterAnchor) {
          const identityText = getCommentFirstLineText(primaryNextAfterAnchor);
          comment.primaryNextHash = hashLine(identityText, 0);
          comment.primaryNextHashText = getCommentReadableText(primaryNextAfterAnchor);
        } else {
          comment.primaryNextHash = comment.nextHash;
          comment.primaryNextHashText = "";
        }

        // primaryAnchor: points to next comment OR code line
        if (primaryNextComment) {
          const identityText = getCommentIdentityText(primaryNextComment);
          comment.primaryAnchor = hashLine(identityText, 0);
          comment.primaryAnchorText = getCommentReadableText(primaryNextComment);
        } else {
          comment.primaryAnchor = comment.anchor;
          comment.primaryAnchorText = comment.anchorText;
        }
      }
    }
  }

  return comments;
}

module.exports = { parseDocComs, enrichWithConsecutiveAnchors };
