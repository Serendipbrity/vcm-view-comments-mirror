const vscode = require("vscode");

// ===========================================================================
// Helper functions for loading both shared and private VCM files
// ===========================================================================

// Load all comments from both shared and private VCM files
async function readSharedVCM(relativePath, vcmSharedDir) {
  const fileUri = vscode.Uri.joinPath(vcmSharedDir, relativePath + ".vcm.json");
  try {
    const data = JSON.parse((await vscode.workspace.fs.readFile(fileUri)).toString());
    return (data.comments || []).map(c => ({ ...c, isPrivate: false }));
  } catch {
    return [];
  }
}

async function readPrivateVCM(relativePath, vcmPrivateDir) {
  const fileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");
  try {
    const data = JSON.parse((await vscode.workspace.fs.readFile(fileUri)).toString());
    return (data.comments || []).map(c => ({ ...c, isPrivate: true }));
  } catch {
    return [];
  }
}

async function readBothVCMs(relativePath, vcmSharedDir, vcmPrivateDir) {
  const [sharedComments, privateComments] = await Promise.all([
    readSharedVCM(relativePath, vcmSharedDir),
    readPrivateVCM(relativePath, vcmPrivateDir),
  ]);

  return {
    sharedComments,
    privateComments,
    allComments: [...sharedComments, ...privateComments],
  };
}

module.exports = { readSharedVCM, readPrivateVCM, readBothVCMs };
