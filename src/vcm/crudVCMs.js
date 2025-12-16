const vscode = require("vscode");
const { vcmFileExists } = require("./vcmFileExists");

// ============================================================================
// crudVCMs()
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
async function crudVCMs(relativePath, comments, vcmDir) {
  const vcmPrivateDir = vscode.Uri.joinPath(vscode.Uri.joinPath(vcmDir, ".."), "private");
    const sharedComments = comments.filter(c => !c.isPrivate);
    const privateComments = comments.filter(c => c.isPrivate).map(c => {
      const { isPrivate, ...rest } = c;
      return rest; // Remove isPrivate flag when saving to private file
    });

    // Save shared comments (only if there are shared comments or a shared VCM file already exists)
    const sharedExists = await vcmFileExists(vcmDir, relativePath);
    if (sharedComments.length > 0 || sharedExists) {
      // Ensure the base .vcm/shared directory exists
      await vscode.workspace.fs.createDirectory(vcmDir).catch(() => {});

      const sharedFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
      const sharedData = {
        file: relativePath,
        lastModified: new Date().toISOString(),
        comments: sharedComments,
      };

      // Ensure dir structure exists
      const pathParts = relativePath.split(/[\\/]/);
      if (pathParts.length > 1) {
        const vcmSubdir = vscode.Uri.joinPath(vcmDir, pathParts.slice(0, -1).join("/"));
        await vscode.workspace.fs.createDirectory(vcmSubdir).catch(() => {});
      }

      await vscode.workspace.fs.writeFile(
        sharedFileUri,
        Buffer.from(JSON.stringify(sharedData, null, 2), "utf8")
      );
    }

    // 4️⃣ Private VCM path + write or delete
    const privateFileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");
    if (privateComments.length > 0) {
      const privateData = {
        file: relativePath,
        lastModified: new Date().toISOString(),
        comments: privateComments,
      };

      const pathParts = relativePath.split(/[\\/]/);
      if (pathParts.length > 1) {
        const vcmPrivateSubdir = vscode.Uri.joinPath(vcmPrivateDir, pathParts.slice(0, -1).join("/"));
        await vscode.workspace.fs.createDirectory(vcmPrivateSubdir).catch(() => {});
      }

      await vscode.workspace.fs.writeFile(
        privateFileUri,
        Buffer.from(JSON.stringify(privateData, null, 2), "utf8")
      );
    } else {
      // Delete private VCM file if no private comments
      const privateFileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");
      try {
        await vscode.workspace.fs.delete(privateFileUri);
      } catch {
        // Ignore non-existent file
      }
    }
  }

  module.exports = {
    crudVCMs,
  };