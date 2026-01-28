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
  const vcmAlwaysShow =
    vcmComment.alwaysShow ||
    (vcmComment.block && vcmComment.block.some((b) => b.alwaysShow));
  const docAlwaysShow =
    docComment.alwaysShow ||
    (docComment.block && docComment.block.some((b) => b.alwaysShow));

  // Use primary matching only when BOTH comments have primary fields
  const vcmHasPrimary =
    vcmComment.primaryPrevHash !== undefined ||
    vcmComment.primaryNextHash !== undefined ||
    vcmComment.primaryAnchor !== undefined;
  const docHasPrimary =
    docComment.primaryPrevHash !== undefined ||
    docComment.primaryNextHash !== undefined ||
    docComment.primaryAnchor !== undefined;
  const hasPrimary = vcmHasPrimary && docHasPrimary;
    
    if (hasPrimary) {
      if (
        buildContextKey(vcmComment, { usePrimaryAnchor: true }) !==
        buildContextKey(docComment, { usePrimaryAnchor: true })
      ) {
        return false;
      }
    } else {
    // if context keys differ, comments are not the same
    if (buildContextKey(vcmComment) !== buildContextKey(docComment)) return false;
  }

  const docText = getCommentText(docComment);
  const vcmText = getCommentText(vcmComment);

  if (vcmComment.type === "line") {
    if (
      typeof vcmComment.commentedLineIndex === "number" &&
      typeof docComment.commentedLineIndex === "number" &&
      vcmComment.commentedLineIndex !== docComment.commentedLineIndex
    ) {
      return false;
    }
  }

  if (vcmComment.type === "block") {
    const vcmBlock = Array.isArray(vcmComment.block)
      ? vcmComment.block
      : Array.isArray(vcmComment.text_cleanMode)
        ? vcmComment.text_cleanMode
        : null;
    const docBlock = Array.isArray(docComment.block)
      ? docComment.block
      : Array.isArray(docComment.text_cleanMode)
        ? docComment.text_cleanMode
        : null;
    const vcmFirstIdx = vcmBlock?.[0]?.commentedLineIndex;
    const docFirstIdx = docBlock?.[0]?.commentedLineIndex;
    if (
      typeof vcmFirstIdx === "number" &&
      typeof docFirstIdx === "number" &&
      vcmFirstIdx !== docFirstIdx
    ) {
      return false;
    }
  }

  // If either side lacks text, comments are not the same
  if (!docText || !vcmText) return false;

  // if context keys match (first conditional didn't fail), and text matches, comments are the same
  return docText === vcmText;
}

module.exports = { isSameComment };
