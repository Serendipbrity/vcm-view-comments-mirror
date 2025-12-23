const vscode = require("vscode");

function getVCMPaths(vcmBaseDir, relativePath) {
  const sharedDir = vscode.Uri.joinPath(vcmBaseDir, "shared");
  const privateDir = vscode.Uri.joinPath(vcmBaseDir, "private");

  return {
    sharedDir,
    privateDir,
    sharedFileUri: vscode.Uri.joinPath(sharedDir, relativePath + ".vcm.json"),
    privateFileUri: vscode.Uri.joinPath(privateDir, relativePath + ".vcm.json"),
  };
}

module.exports = { getVCMPaths };
