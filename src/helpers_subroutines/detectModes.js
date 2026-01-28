const { buildContextKey } = require("../utils_copycode/buildContextKey");
const { getCommentText } = require("../utils_copycode/getCommentText");
const { isAlwaysShow } = require("./alwaysShow");

function createDetectors({
  readSharedVCM,
  vcmDir,
  readPrivateVCM,
  vcmPrivateDir,
  parseDocComs,
  vscode,
  vcmFileExists,
}) {

  // SHARED MODE DETECTION: clean vs commented
  async function detectInitialMode(doc, options = {}) {
    const opts =
      options && typeof options === "object" && !Array.isArray(options) ? options : {};
    const storedMode = typeof opts.storedMode === "boolean" ? opts.storedMode : undefined;

    // get file path relative to workspace root e.g. src/file.ts instead of full file:///...)
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    try {
      const sharedVCMExists = await vcmFileExists(vcmDir, relativePath);

      // No shared VCM → user never used clean/commented.
      // Just say "commented" if the file has any comments at all.
      if (!sharedVCMExists) {
        const vcmObjects = parseDocComs(doc.getText(), doc.uri.path);
        return vcmObjects.length > 0;
      }

      const sharedComments = await readSharedVCM(relativePath, vcmDir);

      // Toggleable shared = shared comments that are NOT alwaysShow.
      const toggleableShared = sharedComments.filter((c) => !isAlwaysShow(c));

      // All shared are alwaysShow → clean vs commented is visually identical.
      // Pick a stable default (isCommented = false → clean mode).
      if (toggleableShared.length === 0) {
        return false;
      }

      const isCleanModeDerived = (comment) => {
        if (!comment) return false;
        if (comment.cleanModeOrigin === true) return true;
        if (comment.text_cleanMode === undefined || comment.text_cleanMode === null) return false;
        if (comment.type === "block") {
          return Array.isArray(comment.text_cleanMode) && comment.text_cleanMode.length > 0;
        }
        if (comment.type === "line" || comment.type === "inline") {
          return typeof comment.text_cleanMode === "string" && comment.text_cleanMode.length > 0;
        }
        return false;
      };

      // Ignore clean-mode-origin comments for detection; they don't indicate mode.
      const detectionCandidates = toggleableShared.filter((c) => !isCleanModeDerived(c));
      if (detectionCandidates.length === 0) {
        return storedMode !== undefined ? storedMode : false;
      }

      const text = doc.getText();
      const vcmObjects = parseDocComs(text, doc.uri.path);

      if (vcmObjects.length === 0) {
        return storedMode !== undefined ? storedMode : false;
      }

      const docKeys = new Set(vcmObjects.map((obj) => buildContextKey(obj)));
      const docTexts = vcmObjects.map((obj) => getCommentText(obj)).filter(Boolean);

      // 1) Strong match: any toggleable shared comment by anchor key
      for (const shared of detectionCandidates) {
        if (docKeys.has(buildContextKey(shared))) {
          return true;
        }
      }

      // 2) Fallback: any toggleable shared comment by text (anchors drifted/edited)
      for (const shared of detectionCandidates) {
        const sharedText = getCommentText(shared);
        if (!sharedText) continue;
        if (docTexts.some((t) => t.includes(sharedText))) {
          return true;
        }
      }

      return storedMode !== undefined ? storedMode : false; // true = commented, false = clean
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
      // Check if private VCM file exists
      const privateVCMExists = await vcmFileExists(vcmPrivateDir, relativePath);

      // If no private VCM file exists, return false (nothing to show)
      if (!privateVCMExists) {
        return false;
      }

      // Load private comments from VCM
      const privateComments = await readPrivateVCM(relativePath, vcmPrivateDir);

      // If VCM exists but has no comments, return false (nothing to show)
      if (!privateComments || privateComments.length === 0) {
        return false;
      }

      // Extract current comments from document (only need to check if ONE exists)
      const text = doc.getText();
      const docComments = parseDocComs(text, doc.uri.path);

      // Only check the first private comment for efficiency (if one is visible, they all should be)
      const firstPrivate = privateComments[0];
      const firstPrivateKey = buildContextKey(firstPrivate);
      const firstPrivateText = getCommentText(firstPrivate);

      // Check if the first private comment exists in current document
      for (const current of docComments) {
        const currentKey = buildContextKey(current);

        // Match by key (exact anchor match)
        if (currentKey === firstPrivateKey) {
          return true; // Found the first private comment in the document
        }

        // Match by text (in case anchor changed)
        if (firstPrivateText) {
          const currentText = getCommentText(current);
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
