/**
 * Extract text content from a comment object
 * Handles both inline and block comment types
 * @param {Object} comment - Comment object with type, text, and/or block properties
 * @returns {string} The extracted text, or empty string if no text available
 *
 * For inline/line: returns text OR text_cleanMode
 * For block: returns block OR text_cleanMode array (joined)
 */
function getCommentText(comment) {
    // inline/line: text OR text_cleanMode
    if (comment.type === "inline" || comment.type === "line") {
        return comment.text || comment.text_cleanMode || "";
    }

    // block: block OR text_cleanMode array
    if (comment.type === "block") {
        const blockArray = comment.block || comment.text_cleanMode;
        return blockArray ? blockArray.map(b => b.text).join("\n") : "";
    }

    // Fallback for comments without type field
    return comment.text || (comment.block ? comment.block.map(b => b.text).join("\n") : "");
}

module.exports = { getCommentText };
