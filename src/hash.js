const crypto = require("crypto");

// Create a unique hash for each line of code based ONLY on content
// This makes the hash stable even when line numbers change
// Format: MD5(trimmed_line) truncated to 8 chars
// Example: "x = 5" -> "a3f2b1c4"
function hashLine(line, lineIndex) {
  return crypto.createHash("md5")
  .update(line.trim())  // Hash content and removes spaces at both ends so formatting changes don’t alter the hash.
  .digest("hex") // Finalizes the hash and converts it to a hexadecimal string.
}

module.exports = {
  hashLine,
};
