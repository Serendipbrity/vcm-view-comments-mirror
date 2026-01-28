const { injectComments, stripComments } = require("./injectExtractComments");
const { parseDocComs } = require("../vcm/utils_copycode/parseDocComs");
const { isSameComment } = require("../utils_copycode/isSameComment");
const { mergeSharedTextCleanMode } = require("../utils_copycode/mergeTextCleanMode");

async function generateCommentedVersion(text, filePath, relativePath, readSharedVCM, vcmDir) {
  const existingSharedComments = await readSharedVCM(relativePath, vcmDir);
  const mergedSharedComments = mergeSharedTextCleanMode(existingSharedComments);
  const docComments = parseDocComs(text, filePath);
  const stripTargets = mergedSharedComments.filter((vcmComment) =>
    docComments.some((dc) => isSameComment(vcmComment, dc))
  );
  const cleanText = stripComments(text, filePath, stripTargets);
  const newText = injectComments(cleanText, filePath, mergedSharedComments, true, false);

  return newText;
}

module.exports = { generateCommentedVersion };
