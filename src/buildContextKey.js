// buildContextKey builds a unique lookup key for a comment using its identifying hashes 
// so we can reliably match the same comment across the file, even when line numbers change.
// It returns a 4-part fingerprint that looks like type:anchor:prevHash:nextHash
// ex) inline:abc123:def456:ghi789
function buildContextKey(comment) {
  // comment.type separates logic for inline vs block comments.
  // comment.anchor is the hash of the code line the comment is attached to.
  // prev and next hash pinpoint any comments with identical anchors
  return `${comment.type}:${comment.anchor}:${comment.prevHash || "null"}:${comment.nextHash || "null"}`;
}

module.exports = {
  buildContextKey,
};