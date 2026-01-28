function mergeSharedTextCleanMode(sharedComments) {
  return sharedComments.map(comment => {
    const merged = { ...comment };

    if (comment.text_cleanMode) {
      merged.cleanModeOrigin = true;
      if (comment.type === "inline") {
        // For inline: append clean-mode text to the existing inline comment.
        merged.text = (comment.text || "") + (comment.text_cleanMode || "");
        merged.text_cleanMode = null;
      } else if (comment.type === "line") {
        // For line: clean-mode text becomes the active text when toggling back.
        merged.text = comment.text_cleanMode;
        merged.text_cleanMode = null;
      } else if (comment.type === "block") {
        // For block: clean-mode text becomes the active block when toggling back.
        merged.block = comment.text_cleanMode;
        merged.text_cleanMode = null;
      }
    }

    return merged;
  });
}

module.exports = {
  mergeSharedTextCleanMode,
};
