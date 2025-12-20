const { buildContextKey } = require("./buildContextKey");

function createDetectors({
  readBothVCMs,
  parseDocComs,
  vscode,
}) {

  const isAlwaysShow = (c) =>
    c.alwaysShow || (c.block && c.block.some((b) => b.alwaysShow));

  // SHARED MODE DETECTION: clean vs commented
  async function detectInitialMode(doc) {
    // get file path relative to workspace root e.g. src/file.ts instead of full file:///...)
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    try {
      const { sharedComments = [] } = await readBothVCMs(relativePath);

      // No shared VCM → user never used clean/commented.
      // Just say "commented" if the file has any comments at all.
      if (sharedComments.length === 0) {
        const vcmObjects = parseDocComs(doc.getText(), doc.uri.path);
        return vcmObjects.length > 0;
      }

      // Toggleable shared = shared comments that are NOT alwaysShow.
      const toggleableShared = sharedComments.filter((c) => !isAlwaysShow(c));

      // All shared are alwaysShow → clean vs commented is visually identical.
      // Pick a stable default (isCommented = false → clean mode).
      if (toggleableShared.length === 0) {
        return false;
      }

      // Use the FIRST toggleable shared comment as the detection anchor.
      const anchorShared = toggleableShared[0];
      const anchorKey = buildContextKey(anchorShared);

      const text = doc.getText();
      const vcmObjects = parseDocComs(text, doc.uri.path);

      // 1) Strong match: by anchor key
      const foundByKey = vcmObjects.some((obj) => buildContextKey(obj) === anchorKey);
      if (foundByKey) {
        return true; // commented mode
      }

      // 2) Fallback: match by comment text (in case something drifted)
      let anchorText = null;
      if (anchorShared.type === "inline") {
        anchorText = anchorShared.text || null;
      } else if (anchorShared.block && anchorShared.block[0]) {
        anchorText = anchorShared.block[0].text || null;
      }

      if (!anchorText) {
        // No usable text signature; safest guess is clean.
        return false;
      }

      const foundByText = vcmObjects.some((c) => {
        if (c.type === "inline") {
          return c.text && c.text.includes(anchorText);
        }
        if (c.block) {
          return c.block.some((b) => b.text && b.text.includes(anchorText));
        }
        return false;
      });

      return foundByText; // true = commented, false = clean
    } catch {
      // VCM missing/unreadable -> just fall back to "does this file have comments?"
      const vcmObjects = parseDocComs(doc.getText(), doc.uri.path);
      return vcmObjects.length > 0;
    }
  }

  // Detect if private comments are currently visible in the document
  // Returns: true if private comments are visible, false if hidden
  // This is a FALLBACK - should only be used when state is not in the map
  async function detectPrivateVisibility(doc, relativePath) {
    try {
      // Load private comments from VCM
      const { privateComments } = await readBothVCMs(relativePath);

      // If no private comments exist, return false (nothing to show)
      if (!privateComments || privateComments.length === 0) {
        return false;
      }

      // Extract current comments from document (only need to check if ONE exists)
      const text = doc.getText();
      const docComments = parseDocComs(text, doc.uri.path);

      // Only check the first private comment for efficiency (if one is visible, they all should be)
      const firstPrivate = privateComments[0];
      const firstPrivateKey = buildContextKey(firstPrivate);
      const firstPrivateText =
        firstPrivate.text ||
        (firstPrivate.block
          ? firstPrivate.block.map((b) => b.text).join("\n")
          : "");

      // Check if the first private comment exists in current document
      for (const current of docComments) {
        const currentKey = buildContextKey(current);

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
      // On failure, err on the side of NOT hiding anything.
      // Treat private as visible so no "hide private" operation runs based on bad detection.
      return true;
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
