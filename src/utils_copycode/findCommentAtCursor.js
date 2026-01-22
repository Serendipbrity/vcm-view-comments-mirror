/**
 * Find a comment at a specific line number
 * @param {Array} docComments - Array of comment objects from parseDocComs
 * @param {number} selectedLine - Line number to search for
 * @returns {Object|undefined} The comment at that line, or undefined if not found
 */
function findCommentAtCursor(docComments, selectedLine) {
    return docComments.find(c => {
        if (c.type === "inline" || c.type === "line") {
            return c.commentedLineIndex === selectedLine;
        } else if (c.type === "block" && c.block) {
            return c.block.some(b => b.commentedLineIndex === selectedLine);
        }
        return false;
    });
}

module.exports = { findCommentAtCursor };