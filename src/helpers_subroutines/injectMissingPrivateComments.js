const { injectComments } = require("./injectExtractComments");
const { parseDocComs, addPrimaryAnchors } = require("../vcm/utils_copycode/parseDocComs");
const { isSameComment } = require("../utils_copycode/isSameComment");

/**
 * injectMissingPrivateComments is a guard/wrapper around injectComments
 * Only Inject private comments that are missing from the document
 * Prevents double-injection by only injecting comments that don't already exist
 * Differences between:
 * - injectComments = "blind inject"
 * - injectMissingPrivateComments = "inject only what isn't already present (by contextKey)"
 *
 * @param {string} text - Current document text
 * @param {string} filePath - File path for comment marker detection
 * @param {Array} privateComments - Private comments from VCM
 * @returns {string} Text with missing private comments injected
 */
function injectMissingPrivateComments(text, filePath, privateComments) {
  const existing = parseDocComs(text, filePath);
  addPrimaryAnchors(existing, { lines: text.split("\n") });
  const missingPrivate = privateComments.filter(c => !existing.some(e => isSameComment(e, c)));

  if (missingPrivate.length > 0) {
    return injectComments(text, filePath, missingPrivate, true, true);
  }

  return text;
}

module.exports = { injectMissingPrivateComments };
