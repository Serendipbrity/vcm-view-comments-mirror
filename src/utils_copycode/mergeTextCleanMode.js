function mergeSharedTextCleanMode(sharedComments) {
  return sharedComments.map(comment => {
    const merged = { ...comment };

    if (comment.text_cleanMode) {
      if (comment.type === "inline") {
        // For inline: text_cleanMode is a string, prepend to text
        merged.text = (comment.text_cleanMode || "") + (comment.text || "");
      } else if (comment.type === "block") {
        // For block: text_cleanMode is a block array, prepend to block
        merged.block = [...(comment.text_cleanMode || []), ...(comment.block || [])];
      }
      merged.text_cleanMode = null;
    }

    return merged;
  });
}

module.exports = {
  mergeSharedTextCleanMode,
};