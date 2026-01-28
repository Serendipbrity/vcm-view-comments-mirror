// buildContextKey builds a unique lookup key for a comment using its identifying hashes
// so we can reliably match the same comment across the file, even when line numbers change.
// It returns a 4-part fingerprint that looks like type:anchor:prevHash:nextHash
// ex) inline:abc123:def456:ghi789
//
// For consecutive comments, can use primaryAnchor with its corresponding
// context hashes instead of the base anchor.
function buildContextKey(comment, options = {}) {
  const { usePrimaryAnchor = false } = options;
  const usePrimary = usePrimaryAnchor && comment.type !== "inline";

  let anchorToUse = comment.anchor;
  let prevHashToUse = comment.prevHash || "null";
  let nextHashToUse = comment.nextHash || "null";

  // Use primaryAnchor with its corresponding context hashes
  if (usePrimary && comment.primaryAnchor) {
    anchorToUse = comment.primaryAnchor;
    prevHashToUse = comment.primaryPrevHash || "null";
    nextHashToUse = comment.primaryNextHash || "null";
  }
  // comment.type separates logic for inline vs block comments.
  // anchorToUse is the hash of either: code line, next comment, or next shared comment
  // prev and next hash pinpoint any comments with identical anchors
  return `${comment.type}:${anchorToUse}:${prevHashToUse}:${nextHashToUse}`;
}

module.exports = {
  buildContextKey,
};