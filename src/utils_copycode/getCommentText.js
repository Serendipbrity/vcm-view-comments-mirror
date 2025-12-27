/**
 * Extract text content from a comment object
 * Handles both inline and block comment types
 * @param {Object} comment - Comment object with type, text, and/or block properties
 * @returns {string} The extracted text, or empty string if no text available
 */
function getCommentText(comment) {
    return comment.text || (comment.block ? comment.block.map(b => b.text).join("\n") : "");
}

module.exports = { getCommentText };
