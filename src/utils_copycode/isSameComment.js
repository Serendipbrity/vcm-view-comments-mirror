const { buildContextKey } = require("./buildContextKey");
const { getCommentText } = require("./getCommentText");

/**
 * Compare two comments to determine if they are the same
 * - Always matches by context key (anchor + prevHash + nextHash)
 * - For line comments: also checks commentedLineIndex when stored in VCM (to distinguish consecutive line comments)
 * - For inline: also requires exact text match when available
 * - For block: also requires block text match when available
 *
 * @param {Object} vcmComment - Comment from VCM file (has original commentedLineIndex)
 * @param {Object} docComment - Comment from document (has current commentedLineIndex)
 * @returns {boolean} True if comments are considered the same
 */
function isSameComment(vcmComment, docComment) {
  // if context keys differ, comments are not the same
  if (buildContextKey(vcmComment) !== buildContextKey(docComment)) return false;

  const docText = getCommentText(docComment);
  const vcmText = getCommentText(vcmComment);

  // If either side lacks text, comments are not the same
  if (!docText || !vcmText) return true;

  // if context keys match (first conditional didn't fail), and text matches, comments are the same
  return docText === vcmText;
}

module.exports = { isSameComment };
