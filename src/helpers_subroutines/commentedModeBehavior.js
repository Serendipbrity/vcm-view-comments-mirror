// ==============================================================================
// Commented Mode Behavior - Extracted from toggleCurrentFileComments
// ==============================================================================
// This is the EXACT logic shared comments use when going to commented mode
// Private comments reuse this with different store dependencies
// ==============================================================================

const { generateCommentedVersion } = require("./generateCommentedVersion");
const { mergeSharedTextCleanMode } = require("../utils_copycode/mergeTextCleanMode");
const { stripComments, injectComments } = require("./injectExtractComments");

/**
 * Commented mode behavior - inject comments from VCM
 * Extracted from toggleCurrentFileComments lines 518-559
 */
async function commentedModeBehavior({
  doc,
  text,
  relativePath,
  saveVCM,
  readVCM,
  writeVCM,
  vcmDir,
  injectFn = injectComments
}) {
  let newText;
  try {
    newText = await generateCommentedVersion(text, doc.uri.path, relativePath, readVCM, vcmDir);

    const existingComments = await readVCM(relativePath, vcmDir);
    const mergedComments = mergeSharedTextCleanMode(existingComments);
    await writeVCM(relativePath, mergedComments, vcmDir);
  } catch {
    await saveVCM(doc, true);
    const comments = await readVCM(relativePath, vcmDir);
    const cleanText = stripComments(text, doc.uri.path, comments);
    newText = injectFn(cleanText, doc.uri.path, comments);
  }
  return newText;
}

module.exports = { commentedModeBehavior };
