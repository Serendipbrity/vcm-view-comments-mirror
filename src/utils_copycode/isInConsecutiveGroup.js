// This file is used to check if a comment is part of a consecutive group so that we know when to use primary fields for matching. If consecutive, yes we use primary fields. Since primary fields are allowed to be comments. 

const { isNextAComment, isPrevAComment } = require("./isComment");

/**
 * Check if a comment is part of a consecutive group (2+ adjacent line/block comments)
 * Used to determine when to use primary fields for matching
 * @param {Object} target - The comment to check
 * @param {string[]} lines - Array of all lines in the document
 * @param {string} filePath - File path for determining comment markers
 * @returns {boolean} True if target is in a consecutive group
 */
function isInConsecutiveGroup(target, lines, filePath) {
  // Inline comments can't be part of consecutive groups
  if (!target || target.type === "inline") return false;

  // Get the line range for the target comment
  let startLine, endLine;

  if (target.type === "block") {
    const blockArray = target.block || target.text_cleanMode;
    if (Array.isArray(blockArray) && blockArray.length > 0) {
      const indices = blockArray
        .map((line) => line?.commentedLineIndex)
        .filter((idx) => typeof idx === "number");
      if (indices.length > 0) {
        startLine = Math.min(...indices);
        endLine = Math.max(...indices);
      }
    }
  }

  if (startLine === undefined && typeof target.commentedLineIndex === "number") {
    startLine = target.commentedLineIndex;
    endLine = target.commentedLineIndex;
  }

  if (startLine === undefined) return false;

  // Check if the next or previous non-empty line is a comment
  const prevIsComment = isPrevAComment(lines, startLine, filePath);
  const nextIsComment = isNextAComment(lines, endLine, filePath);

  return prevIsComment || nextIsComment;
}

module.exports = { isInConsecutiveGroup };
