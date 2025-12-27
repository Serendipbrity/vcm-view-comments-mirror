// ==============================================================================
// Clean Mode Behavior - Extracted from toggleCurrentFileComments
// ==============================================================================
// This is the EXACT logic shared comments use when going to clean mode
// Private comments reuse this with different store dependencies
// ==============================================================================

const { stripComments } = require("./injectExtractComments");

/**
 * Clean mode behavior - strip comments and save to VCM
 * Extracted from toggleCurrentFileComments lines 493-516
 */
async function cleanModeBehavior({
  doc,
  text,
  relativePath,
  config,
  saveVCM,
  vcmFileExists,
  vcmDir,
  readVCM
}) {
  const liveSync = config.get("liveSync", false);
  const vcmExists = await vcmFileExists(vcmDir, relativePath);
  if (!vcmExists || !liveSync) {
    await saveVCM(doc, true);
  }
  const comments = await readVCM(relativePath, vcmDir);
  const newText = stripComments(text, doc.uri.path, comments);
  return newText;
}

module.exports = { cleanModeBehavior };
