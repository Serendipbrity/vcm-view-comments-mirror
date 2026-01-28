const { getLineMarkersForFile, getBlockMarkersForFile } = require("./commentMarkers");

/**
 * Check if a line is a comment (line comment or inside/start of block comment)
 * @param {string} line - The line text
 * @param {string} filePath - File path for determining comment markers
 * @param {Object} blockState - Track block comment state { inBlock: boolean, blockEnd: string|null }
 * @returns {boolean} True if line is a comment
 */
function isComment(line, filePath, blockState = { inBlock: false, blockEnd: null }) {
  const trimmed = line.trim();

  // Empty lines are not comments
  if (!trimmed) return false;

  const lineMarkers = getLineMarkersForFile(filePath);
  const blockMarkers = getBlockMarkersForFile(filePath);

  // If we're inside a block comment
  if (blockState.inBlock) {
    const endIdx = line.indexOf(blockState.blockEnd);
    if (endIdx >= 0) {
      blockState.inBlock = false;
      blockState.blockEnd = null;
    }
    return true;
  }

  // Check for line comment
  for (const marker of lineMarkers) {
    if (trimmed.startsWith(marker)) {
      return true;
    }
  }

  // Check for block comment start
  for (const { start, end } of blockMarkers) {
    const startIdx = line.indexOf(start);
    if (startIdx >= 0) {
      // Only a comment if the block marker is at the start of content
      const beforeMarker = line.slice(0, startIdx).trim();
      if (beforeMarker.length === 0) {
        const endIdx = line.indexOf(end, startIdx + start.length);
        if (endIdx < 0) {
          // Block continues to next lines
          blockState.inBlock = true;
          blockState.blockEnd = end;
        }
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if the next non-empty line is a comment
 * @param {string[]} lines - Array of all lines in the document
 * @param {number} startLineIndex - Line index to start searching from (exclusive)
 * @param {string} filePath - File path for determining comment markers
 * @returns {boolean} True if next non-empty line is a comment
 */
function isNextAComment(lines, startLineIndex, filePath) {
  // Determine block state by scanning from top to the start line
  const blockState = { inBlock: false, blockEnd: null };
  for (let i = 0; i <= startLineIndex && i < lines.length; i++) {
    isComment(lines[i], filePath, blockState);
  }

  // Find the next non-empty line
  for (let i = startLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue; // Skip empty lines

    return isComment(line, filePath, blockState);
  }

  return false;
}

/**
 * Check if the previous non-empty line is a comment
 * @param {string[]} lines - Array of all lines in the document
 * @param {number} startLineIndex - Line index to start searching from (exclusive)
 * @param {string} filePath - File path for determining comment markers
 * @returns {boolean} True if previous non-empty line is a comment
 */
function isPrevAComment(lines, startLineIndex, filePath) {
  // Find the previous non-empty line
  let prevLineIndex = -1;
  for (let i = startLineIndex - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      prevLineIndex = i;
      break;
    }
  }

  if (prevLineIndex < 0) return false;

  // Determine block state by scanning from top to just before the previous line
  const blockState = { inBlock: false, blockEnd: null };
  for (let i = 0; i < prevLineIndex; i++) {
    isComment(lines[i], filePath, blockState);
  }

  return isComment(lines[prevLineIndex], filePath, blockState);
}

module.exports = { isComment, isNextAComment, isPrevAComment };
