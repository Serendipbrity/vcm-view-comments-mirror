const vscode = require("vscode");

// Check if a VCM file exists
async function vcmFileExists(dir, relativePath) {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, relativePath + ".vcm.json"));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  vcmFileExists,
};