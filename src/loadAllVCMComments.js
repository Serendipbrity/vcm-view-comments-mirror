const vscode = require("vscode");

// ===========================================================================
// Helper functions for loading both shared and private VCM files
// ===========================================================================

// Load all comments from both shared and private VCM files
async function loadAllVCMComments(relativePath, vcmDir) {
  const vcmPrivateDir = vscode.Uri.joinPath(vscode.Uri.joinPath(vcmDir, ".."), "private");
  const sharedFileUri = vscode.Uri.joinPath(vcmDir, relativePath + ".vcm.json");
  const privateFileUri = vscode.Uri.joinPath(vcmPrivateDir, relativePath + ".vcm.json");

    let sharedComments = [];
    let privateComments = [];

    try {
      const sharedData = JSON.parse((await vscode.workspace.fs.readFile(sharedFileUri)).toString());
      sharedComments = sharedData.comments || [];
    } catch {
      // No shared VCM file
    }

    try {
      const privateData = JSON.parse((await vscode.workspace.fs.readFile(privateFileUri)).toString());
      privateComments = (privateData.comments || []).map(c => ({ ...c, isPrivate: true }));
    } catch {
      // No private VCM file
    }
  // return both plus a combined array
  return { sharedComments, privateComments, allComments: [...sharedComments, ...privateComments] };
}

module.exports = {
  loadAllVCMComments,
};