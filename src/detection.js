const { getCommentMarkersForFile } = require("./commentMarkers");

function createDetectors({
  loadAllComments,
  extractComments,
  hashLine,
  vscode,
}) {
  // Detect initial state: are comments visible or hidden?
  // Returns: true if comments are visible (isCommented), false if in clean mode
  async function detectInitialMode(doc, vcmDir) {
    // get file path relative to workspace root
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    try {
      // Try to load the VCM metadata file
      // Detection logic:
      // - If shared comments are visible → commented mode
      // - If only private (or no comments) → clean mode
      const { sharedComments } = await loadAllComments(relativePath);
      const comments = sharedComments || [];

      // No shared comments exist → default to clean mode
      if (comments.length === 0) {
        return false;
      }

      // filter through shared comments and keep only those where alwaysShow property is false or undefined.
      // This separates the comments that are optional (toggleable) from ones that are permanently displayed.
      const nonAlwaysShowComments = comments.filter((c) => !c.alwaysShow);

      // If *Only* alwaysShow shared comments exist, check if any are visible
      if (nonAlwaysShowComments.length === 0) {
        // Rare case: only alwaysShow comments
        // Just check if first alwaysShow comment is visible
        if (comments.length > 0) {
          const firstComment = comments[0];
          const lines = doc.getText().split("\n");
          const lineIndex = firstComment.originalLineIndex;

          if (lineIndex < lines.length) {
            const currentLine = lines[lineIndex];
            const commentText =
              firstComment.text ||
              (firstComment.block && firstComment.block[0]
                ? firstComment.block[0].text
                : "");
            if (commentText && currentLine.includes(commentText)) {
              return true; // alwaysShow comment found, commented mode
            }
          }
        }
        return false;
      }

      // Standard case: Check if first 3 shared (non-alwaysShow) comments are visible
      // Load private comments to exclude them from detection (only first 3 for efficiency)
      const { privateComments } = await loadAllComments(relativePath);
      const privateTexts = new Set();
      const privateCheckLimit = Math.min(3, privateComments.length);
      for (let i = 0; i < privateCheckLimit; i++) {
        const pc = privateComments[i];
        if (pc.type === "inline") {
          privateTexts.add(pc.text);
        } else if (pc.block) {
          for (const block of pc.block) {
            privateTexts.add(block.text);
          }
        }
      }

      // Extract current comments (only what we need for comparison)
      const text = doc.getText();
      const currentComments = extractComments(text, doc.uri.path);

      // Filter current comments to only non-private ones
      const currentNonPrivateComments = currentComments.filter((c) => {
        if (c.type === "inline") {
          return !privateTexts.has(c.text);
        } else if (c.block) {
          return !c.block.some((b) => privateTexts.has(b.text));
        }
        return true;
      });

      // If no non-private comments in document, we're in clean mode
      if (currentNonPrivateComments.length === 0) {
        return false;
      }

      // Check if any of the first 3 shared comments exist in the non-private comments
      const checkCount = Math.min(3, nonAlwaysShowComments.length);
      for (let i = 0; i < checkCount; i++) {
        const sharedComment = nonAlwaysShowComments[i];

        // Get the text to match
        let sharedText;
        if (sharedComment.type === "inline") {
          sharedText = sharedComment.text_cleanMode || sharedComment.text;
        } else if (sharedComment.block) {
          if (sharedComment.text_cleanMode && sharedComment.text_cleanMode[0]) {
            sharedText = sharedComment.text_cleanMode[0].text;
          } else if (sharedComment.block[0]) {
            sharedText = sharedComment.block[0].text;
          }
        }

        if (!sharedText) continue;

        // Check if this shared comment exists in the current non-private comments
        const found = currentNonPrivateComments.some((c) => {
          if (c.type === "inline") {
            return c.text && c.text.includes(sharedText);
          } else if (c.block) {
            return c.block.some((b) => b.text && b.text.includes(sharedText));
          }
          return false;
        });

        if (!found) {
          return false; // Shared comment not found - we're in clean mode
        }
      }

      return true; // All shared sample comments were present, so we're in commented mode.
    } catch {
      // If the .vcm.json didn’t exist or was unreadable:
      // Check if the actual file has comments
      const commentMarkers = getCommentMarkersForFile(doc.uri.path);
      const lines = doc.getText().split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        for (const marker of commentMarkers) {
          // If any line begins with a comment marker, return true (commented).
          if (trimmed.startsWith(marker)) {
            return true; // File has comments - isCommented = true
          }
        }
      }

      return false; // No comments found - isCommented = false
    }
  }

  // Detect if private comments are currently visible in the document
  // Returns: true if private comments are visible, false if hidden
  // This is a FALLBACK - should only be used when state is not in the map
  async function detectPrivateVisibility(doc, relativePath) {
    try {
      // Load private comments from VCM
      const { privateComments } = await loadAllComments(relativePath);

      // If no private comments exist, return false (nothing to show)
      if (privateComments.length === 0) {
        return false;
      }

      // Extract current comments from document (only need to check if ONE exists)
      const text = doc.getText();
      const currentComments = extractComments(text, doc.uri.path);

      // Only check the first private comment for efficiency (if one is visible, they all should be)
      const firstPrivate = privateComments[0];
      const firstPrivateKey = `${firstPrivate.type}:${firstPrivate.anchor}:${
        firstPrivate.prevHash || "null"
      }:${firstPrivate.nextHash || "null"}`;
      const firstPrivateText =
        firstPrivate.text ||
        (firstPrivate.block
          ? firstPrivate.block.map((b) => b.text).join("\n")
          : "");

      // Check if the first private comment exists in current document
      for (const current of currentComments) {
        const currentKey = `${current.type}:${current.anchor}:${
          current.prevHash || "null"
        }:${current.nextHash || "null"}`;

        // Match by key (exact anchor match)
        if (currentKey === firstPrivateKey) {
          return true; // Found the first private comment in the document
        }

        // Match by text (in case anchor changed)
        if (firstPrivateText) {
          const currentText =
            current.text ||
            (current.block ? current.block.map((b) => b.text).join("\n") : "");
          if (currentText === firstPrivateText) {
            return true; // Found the first private comment by text match
          }
        }
      }

      // First private comment not found in document
      return false;
    } catch (error) {
      // If we can't detect (no VCM file, etc.), default to hidden
      return false;
    }
  }

  return {
    detectInitialMode,
    detectPrivateVisibility,
  };
}

module.exports = {
  createDetectors,
};
