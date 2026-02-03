const { findInlineCommentStart, isolateCodeLine, findPrevNextCodeLine } = require("../../utils_copycode/lineUtils");
const { getCommentMarkersForFile, getLineMarkersForFile, getBlockMarkersForFile } = require("../../utils_copycode/commentMarkers");
const { hashLine } = require("../../utils_copycode/hash");
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
  let pendingLineCommentBuffer = null;

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

  const emitLineComments = (lineBuffer, anchorLineIdx) => {
    if (!lineBuffer || lineBuffer.length === 0) return;
    for (const lineObj of lineBuffer) {
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
  };

  // Helper: Emit buffered line comments as individual type:"line" objects
  const flushLineComments = (anchorLineIdx) => {
    emitLineComments(lineCommentBuffer, anchorLineIdx);
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

        // Do not include blank lines outside the block in the block buffer.

        if (pendingLineCommentBuffer && pendingLineCommentBuffer.length > 0) {
          emitLineComments(pendingLineCommentBuffer, anchorLineIdx);
          pendingLineCommentBuffer = null;
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
          commentedLineIndex: blockCommentBuffer[0]?.commentedLineIndex,
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
      if (lineCommentBuffer.length > 0) {
        pendingLineCommentBuffer = lineCommentBuffer;
        lineCommentBuffer = [];
      }

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

        // Do not include blank lines outside the block in the block array.

        if (pendingLineCommentBuffer && pendingLineCommentBuffer.length > 0) {
          emitLineComments(pendingLineCommentBuffer, anchorLineIdx);
          pendingLineCommentBuffer = null;
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
          commentedLineIndex: blockArray[0]?.commentedLineIndex,
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

  const countBlankAbove = (startIdx) => {
    let count = 0;
    for (let j = startIdx - 1; j >= 0; j--) {
      if (lines[j].trim()) break;
      count += 1;
    }
    return count;
  };

  const countBlankBelow = (endIdx) => {
    let count = 0;
    for (let j = endIdx + 1; j < lines.length; j++) {
      if (lines[j].trim()) break;
      count += 1;
    }
    return count;
  };

  const getBlockContentRange = (blockArray) => {
    if (!Array.isArray(blockArray) || blockArray.length === 0) {
      return { start: -1, end: -1 };
    }
    const nonBlankIndices = blockArray
      .filter((b) => b && typeof b.commentedLineIndex === "number")
      .filter((b) => (b.text || "").trim() !== "")
      .map((b) => b.commentedLineIndex);
    if (nonBlankIndices.length > 0) {
      return {
        start: Math.min(...nonBlankIndices),
        end: Math.max(...nonBlankIndices),
      };
    }
    const allIndices = blockArray
      .filter((b) => b && typeof b.commentedLineIndex === "number")
      .map((b) => b.commentedLineIndex);
    if (allIndices.length > 0) {
      return { start: Math.min(...allIndices), end: Math.max(...allIndices) };
    }
    return { start: -1, end: -1 };
  };

  for (const comment of comments) {
    if (comment.type === "inline") continue;
    if (comment.type === "line") {
      const idx = comment.commentedLineIndex;
      if (typeof idx === "number" && idx >= 0 && idx < lines.length) {
        comment.spacingBefore = countBlankAbove(idx);
        comment.spacingAfter  = countBlankBelow(idx);
      } else {
        comment.spacingBefore = 0;
        comment.spacingAfter  = 0;
      }
      continue;
    }

    let rangeStart = -1;
    let rangeEnd = -1;
    if (comment.type === "block") {
      const range = getBlockContentRange(comment.block);
      rangeStart = range.start;
      rangeEnd = range.end;
    } else if (typeof comment.commentedLineIndex === "number") {
      rangeStart = comment.commentedLineIndex;
      rangeEnd = comment.commentedLineIndex;
    }

    if (rangeStart >= 0 && rangeEnd >= 0) {
      const spacingBefore = countBlankAbove(rangeStart);
      const spacingAfter = countBlankBelow(rangeEnd);
      comment.spacingBefore = spacingBefore;
      comment.spacingAfter = spacingAfter;
    }
  }

  return comments;
}

function addPrimaryAnchors(comments, options = {}) {
  const lines = Array.isArray(options.lines) ? options.lines : null;

  // Step 1: Group comments into consecutive stacks by document contiguity
  // Why base anchor alone is insufficient: comments with same anchor may not be contiguous
  // (e.g., two comment groups separated by code but anchoring to the same later line).
  // We need contiguous regions to correctly model comment-to-comment relationships.
  const stacks = [];
  let currentStack = [];
  let prevRange = null;

  const getCommentLineRange = (c) => {
    if (c.type === "block") {
      const blockArray = Array.isArray(c.block) ? c.block : Array.isArray(c.text_cleanMode) ? c.text_cleanMode : null;
      if (blockArray && blockArray.length > 0) {
        const indices = blockArray
          .map((line) => line && line.commentedLineIndex)
          .filter((idx) => typeof idx === "number");
        if (indices.length > 0) {
          return { start: Math.min(...indices), end: Math.max(...indices) };
        }
      }
    }

    if (typeof c.commentedLineIndex === "number") {
      return { start: c.commentedLineIndex, end: c.commentedLineIndex };
    }

    return { start: -1, end: -1 };
  };

  const consecutiveComments = comments.filter(
    (c) =>
      // c.type === "inline" ||
      c.type === "block" ||
      (c.type === "line" && (c.text || c.text_cleanMode || "").trim())
  );

  for (const comment of consecutiveComments) {
    const range = getCommentLineRange(comment);
    if (range.start < 0) continue;

    if (currentStack.length === 0) {
      currentStack.push(comment);
      prevRange = range;
      continue;
    }

    const areOnlyBlankLinesBetween = (prev, next) => {
      if (!lines) return false;
      if (next.start <= prev.end + 1) return false;
      for (let j = prev.end + 1; j < next.start; j++) {
        if (lines[j] && lines[j].trim()) return false;
      }
      return true;
    };
    // TODO: change this to check buildcontext keys (without primary. so only code lines)
    // if the contextkeys are the same then they are consecutive comments and should use primary
    const isAdjacent = prevRange && (
      range.start === prevRange.end + 1 ||
      areOnlyBlankLinesBetween(prevRange, range)
    );
    if (isAdjacent) {
      currentStack.push(comment);
    } else {
      stacks.push(currentStack);
      currentStack = [comment];
    }
    prevRange = range;
  }
  if (currentStack.length > 0) stacks.push(currentStack);

  // Step 2: Process each stack
  for (const stack of stacks) {
    // Only enrich if stack has multiple comments (consecutive)
    // if (stack.length <= 1) continue;

    // Process each comment in the stack - add primary fields for ordering
    for (let i = 0; i < stack.length; i++) {
      const comment = stack[i];
      const range = getCommentLineRange(comment);

      // PRIMARY PREV: Find immediate non-empty line before this comment (comment or code)
      if (lines && range.start > 0) {
        for (let j = range.start - 1; j >= 0; j--) {
          const lineText = lines[j];
          if (lineText && lineText.trim()) {
            comment.primaryPrevHash = hashLine(lineText, 0);
            comment.primaryPrevHashText = lineText;
            break;
          }
        }
      }

      // PRIMARY ANCHOR: Find immediate non-empty line after this comment (comment or code)
      if (lines && range.end >= 0 && range.end < lines.length - 1) {
        for (let j = range.end + 1; j < lines.length; j++) {
          const lineText = lines[j];
          if (lineText && lineText.trim()) {
            comment.primaryAnchor = hashLine(lineText, 0);
            comment.primaryAnchorText = lineText;
            break;
          }
        }
      }

      // PRIMARY NEXT: Find the line after the anchor (second non-empty line after this comment)
      if (lines && range.end >= 0 && range.end < lines.length - 1) {
        let foundFirst = false;
        for (let j = range.end + 1; j < lines.length; j++) {
          const lineText = lines[j];
          if (lineText && lineText.trim()) {
            if (!foundFirst) {
              foundFirst = true;
              continue;
            }
            comment.primaryNextHash = hashLine(lineText, 0);
            comment.primaryNextHashText = lineText;
            break;
          }
        }
      }
    }
  }

  return comments;
}

module.exports = { parseDocComs, addPrimaryAnchors };
