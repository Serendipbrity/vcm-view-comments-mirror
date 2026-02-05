const vscode = require("vscode");
const { findCommentAtCursor } = require("../utils_copycode/findCommentAtCursor");
const { addPrimaryAnchors } = require("../vcm/utils_copycode/parseDocComs");
const { isSameComment } = require("../utils_copycode/isSameComment");

/**
 * Check if a comment is marked as alwaysShow
 * Checks both the comment itself and individual block lines
 * @param {Object} comment - Comment object (inline or block)
 * @returns {boolean} True if comment or any of its block lines have alwaysShow
 */
function isAlwaysShow(comment) {
  return comment.alwaysShow;
}

async function updateAlwaysShowContext({ readBothVCMs, parseDocComs }) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', false);
      return;
    }

    const doc = editor.document;
    const selectedLine = editor.selection.active.line;
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    try {
      // Extract current comments and find the one at cursor position
      const docText = doc.getText();
      const docLines = docText.split("\n");
      const docComments = parseDocComs(docText, doc.uri.path);

      // Load VCM comments to check flags
      const { allComments: comments } = await readBothVCMs(relativePath);

      let isAlwaysShowFlag = false;
      let isPrivate = false;

      const privateComments = comments.filter(c => c.isPrivate);
      addPrimaryAnchors(docComments, { lines: docLines });

      // Find the comment at the current cursor position
      const commentAtCursor = findCommentAtCursor(docComments, selectedLine);

      // Set cursorOnComment based on whether we found a comment
      await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', !!commentAtCursor);

      if (!comments || comments.length === 0) {
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
        return;
      }

      if (!commentAtCursor) {
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
        return;
      }

      // Check if any VCM comment matches and has alwaysShow
      // alwaysShow comments are always in the doc, so isSameComment works directly
      for (const c of comments) {
        if (isSameComment(c, commentAtCursor) && isAlwaysShow(c)) {
          isAlwaysShowFlag = true;
          break;
        }
      }

      if (privateComments.length > 0) {
        isPrivate = privateComments.some((c) => isSameComment(c, commentAtCursor));
      }

      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', isAlwaysShowFlag);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', isPrivate);
    } catch {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
      await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', false);
    }
}

function updateAlwaysShow(context, deps) {
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() =>
      updateAlwaysShowContext(deps)
    )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() =>
      updateAlwaysShowContext(deps)
    )
  );

  updateAlwaysShowContext(deps);
}

module.exports = {
  updateAlwaysShow,
  isAlwaysShow,
};