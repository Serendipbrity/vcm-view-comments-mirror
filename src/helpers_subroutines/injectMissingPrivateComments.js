const { buildContextKey } = require("../utils_copycode/buildContextKey");
const { injectComments } = require("./injectExtractComments");
const { parseDocComs } = require("../vcm/utils_copycode/parseDocComs");

/**
 * Inject private comments that are missing from the document
 * Prevents double-injection by only injecting comments that don't already exist
 *
 * @param {string} text - Current document text
 * @param {string} filePath - File path for comment marker detection
 * @param {Array} privateComments - Private comments from VCM
 * @returns {string} Text with missing private comments injected
 */
function injectMissingPrivateComments(text, filePath, privateComments) {
  const existing = parseDocComs(text, filePath);
  const existingKeys = new Set(existing.map(c => buildContextKey(c)));
  const missingPrivate = privateComments.filter(c => !existingKeys.has(buildContextKey(c)));

  if (missingPrivate.length > 0) {
    return injectComments(text, filePath, missingPrivate);
  }

  return text;
}

module.exports = { injectMissingPrivateComments };
