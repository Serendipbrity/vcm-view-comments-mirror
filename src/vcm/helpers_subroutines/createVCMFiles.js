const vscode = require("vscode");
const { vcmFileExists } = require("../utils_copycode/vcmFileExists");

// ============================================================================
// createVCMFiles()
// ============================================================================
// Low-level writer that splits comments into shared and private VCM files.
// This function ALWAYS writes when called (no gating logic).
// Logic:
// - Filters comments by isPrivate flag
// - Writes shared comments to .vcm/shared/{file}.vcm.json
// - Writes private comments to .vcm/private/{file}.vcm.json
// - Creates VCM files if they don't exist
// - Updates VCM files if they exist
// ============================================================================
// src/vcm/vcmIO.js
// Keep writes consistent across shared/private, but let callers choose which to write.

/**
 * Ensures the directory for a file path exists:
 * - baseDir/.vcm.json (and subdirs if relativePath has folders)
 */
async function ensureSubdirsExist(baseDir, relativePath) {
  // Create the base dir (shared or private)
  await vscode.workspace.fs.createDirectory(baseDir).catch(() => {});

  // If relativePath has subfolders, create them inside baseDir
  const pathParts = relativePath.split(/[\\/]/);
  if (pathParts.length > 1) {
    const subdir = vscode.Uri.joinPath(baseDir, pathParts.slice(0, -1).join("/"));
    await vscode.workspace.fs.createDirectory(subdir).catch(() => {});
  }
}

/**
 * Internal generic writer:
 * - If comments.length > 0 OR file already exists -> write file
 * - Else -> delete file
 *
 * `stripIsPrivate`:
 * - shared storage CAN keep isPrivate=false (or omit; your choice)
 * - private storage MUST NOT store isPrivate (canonical store)
 */
async function writeVCMFile({ relativePath, dirUri, comments, stripIsPrivate }) {
  const fileUri = vscode.Uri.joinPath(dirUri, relativePath + ".vcm.json");

  // "Exists" check uses your existing helper that checks in the right folder structure
  const exists = await vcmFileExists(dirUri, relativePath);

  // If no comments and no existing file -> do nothing
  if ((!comments || comments.length === 0) && !exists) {
    return;
  }

  if (comments && comments.length > 0) {
    await ensureSubdirsExist(dirUri, relativePath);

    const normalized = stripIsPrivate
      ? comments.map((c) => {
          // Remove isPrivate flag for canonical private storage
          const { isPrivate, ...rest } = c;
          return rest;
        })
      : comments;

    const payload = {
      file: relativePath,
      lastModified: new Date().toISOString(),
      comments: normalized,
    };

    await vscode.workspace.fs.writeFile(
      fileUri,
      Buffer.from(JSON.stringify(payload, null, 2), "utf8")
    );
    return;
  }

  // comments empty but file exists -> delete
  try {
    await vscode.workspace.fs.delete(fileUri);
  } catch {}
}

/**
 * Write only shared.
 * Caller passes the combined comments array; this function filters.
 */
async function writeSharedVCM(relativePath, comments, vcmSharedDir) {
  const sharedComments = (comments || []).filter((c) => !c.isPrivate);

  await writeVCMFile({
    relativePath,
    dirUri: vcmSharedDir,
    comments: sharedComments,
    stripIsPrivate: false, // shared can keep isPrivate if you want, but you already filter it out
  });
}

/**
 * Write only private.
 * Caller passes the combined comments array; this function filters but KEEPS isPrivate.
 */
async function writePrivateVCM(relativePath, comments, vcmPrivateDir) {
  const privateComments = (comments || []).filter((c) => c.isPrivate);

  await writeVCMFile({
    relativePath,
    dirUri: vcmPrivateDir,
    comments: privateComments,
    stripIsPrivate: false, // Keep isPrivate flag in private VCM for persistence
  });
}


module.exports = {
  writeSharedVCM,
  writePrivateVCM,
};
