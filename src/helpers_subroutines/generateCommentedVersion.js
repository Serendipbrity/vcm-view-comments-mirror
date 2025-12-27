const { injectComments, stripComments } = require("./injectExtractComments");
const { mergeSharedTextCleanMode } = require("../utils_copycode/mergeTextCleanMode");

async function generateCommentedVersion(text, filePath, relativePath, readSharedVCM, vcmDir) {
  const existingSharedComments = await readSharedVCM(relativePath, vcmDir);
  const mergedSharedComments = mergeSharedTextCleanMode(existingSharedComments);
  const cleanText = stripComments(text, filePath, mergedSharedComments);
  const newText = injectComments(cleanText, filePath, mergedSharedComments);

  return newText;
}

module.exports = { generateCommentedVersion };
