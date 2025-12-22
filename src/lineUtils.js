/**
 * Find the start index of the FIRST inline comment marker on a line.
 * - Uses `commentMarkers` passed in (no hard-coded markers).
 * - Skips markers inside quotes (" ' `) using a simple string-state machine.
 * - Optionally requires whitespace immediately before the marker (your current rule).
 * - When requireWhitespaceBefore is true, returns the index of the whitespace char (i - 1),
 *   so the extracted comment text preserves the leading whitespace exactly as typed.
 */
function findInlineCommentStart(line, commentMarkers, { requireWhitespaceBefore = true } = {}) {
  let inString = false;
  let stringChar = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    // If the previous char was "\" then this char is escaped. Clear flag and continue.
    if (escaped) { escaped = false; continue; }

    // Track escaping (only relevant in languages where "\" escapes characters).
    if (char === "\\") { escaped = true; continue; }

    // Enter string on ', ", or ` when not currently in a string.
    if (!inString && (char === '"' || char === "'" || char === "`")) {
      inString = true;
      stringChar = char;
      continue;
    }

    // Exit string when we hit the same delimiter we entered with.
    if (inString && char === stringChar) {
      inString = false;
      stringChar = null;
      continue;
    }

    // While inside a string, do not treat markers as comments.
    if (inString) continue;

    // Outside strings: check every marker at this position.
    for (const marker of commentMarkers) {
      // `startsWith(marker, i)` supports markers of any length (//, --, <!--, etc.)
      if (line.startsWith(marker, i)) {
        // If whitespace isn't required, comment begins exactly at marker start.
        if (!requireWhitespaceBefore) return i;

        // If whitespace IS required, only accept marker when immediately preceded by whitespace.
        // Return i - 1 so the whitespace is included in the comment text, preserving exact formatting.
        if (i > 0 && /\s/.test(line[i - 1])) return i - 1;
      }
    }
  }

  // No inline marker found.
  return -1;
}

/**
 * Return the canonical "code identity" for hashing / anchoring:
 * - If an inline comment exists, return only the code portion before it (trimEnd).
 * - Otherwise return the whole line (trimEnd).
 *
 * This is the function you should use everywhere you currently hash "code lines"
 * (anchor, prevHash, nextHash, match scoring, click matching) so hashes stay consistent
 * across clean/commented mode.
 */
function isolateCodeLine(line, commentMarkers) {
  if (!line) return "";
  const commentStart = findInlineCommentStart(line, commentMarkers, { requireWhitespaceBefore: true });
  if (commentStart >= 0) {
    return line.substring(0, commentStart).trimEnd();
  }
  return line.trimEnd();
}

/**
 * Helper: Find both the previous and next non-blank "code" line indices.
 * - `lines` is the full document split by "\n".
 * - `isComment` must reflect your current definition of "comment-only line".
 *
 * Returns:
 *   { prevIdx: number, nextIdx: number }
 * Where each idx is -1 if not found.
 */
function findPrevNextCodeLine(startIndex, lines, isComment) {
  let prevIdx = -1;
  let nextIdx = -1;

  // Scan backward for prev code line.
  for (let j = startIndex - 1; j >= 0; j--) {
    const trimmed = lines[j].trim();
    if (trimmed && !isComment(lines[j])) { prevIdx = j; break; }
  }

  // Scan forward for next code line.
  for (let j = startIndex + 1; j < lines.length; j++) {
    const trimmed = lines[j].trim();
    if (trimmed && !isComment(lines[j])) { nextIdx = j; break; }
  }

  return { prevIdx, nextIdx };
}

module.exports = {
  findInlineCommentStart,
  isolateCodeLine,
  findPrevNextCodeLine,
};
