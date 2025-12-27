const { buildContextKey } = require("./buildContextKey");
const { getCommentText } = require("./getCommentText");

/**
 * Compare two comments to determine if they are the same
 * - Always matches by context key (anchor + prevHash + nextHash)
 * - For inline: also requires exact text match when available
 * - For block: also requires block text match when available
 *
 * @param {Object} vcmComment - Comment from VCM file
 * @param {Object} docComment - Comment from document
 * @returns {boolean} True if comments are considered the same
 */
function isSameComment(vcmComment, docComment) {
  if (buildContextKey(vcmComment) !== buildContextKey(docComment)) return false;

  if (docComment.type === "inline") {
    // If either side lacks text, fall back to key-only
    if (typeof docComment.text !== "string" || typeof vcmComment.text !== "string") return true;
    return vcmComment.text === docComment.text;
  }

  if (docComment.type === "block") {
    const docBlockText = getCommentText(docComment);
    const vcmBlockText = getCommentText(vcmComment);

    // If either block is missing, fall back to key-only
    if (!docBlockText || !vcmBlockText) return true;
    return docBlockText === vcmBlockText;
  }

  return true;
}

module.exports = { isSameComment };
