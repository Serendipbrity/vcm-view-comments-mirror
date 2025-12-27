const vscode = require("vscode");
const { buildContextKey } = require("./buildContextKey");
const { findCommentAtCursor } = require("./findCommentAtCursor");

/**
 * Check if a comment is marked as alwaysShow
 * Checks both the comment itself and individual block lines
 * @param {Object} comment - Comment object (inline or block)
 * @returns {boolean} True if comment or any of its block lines have alwaysShow
 */
function isAlwaysShow(comment) {
  return comment.alwaysShow || (comment.block && comment.block.some((b) => b.alwaysShow));
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
      const docComments = parseDocComs(doc.getText(), doc.uri.path);

      // Find the comment at the current cursor position
      const commentAtCursor = findCommentAtCursor(docComments, selectedLine);

      // Set cursorOnComment based on whether we found a comment
      await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', !!commentAtCursor);

      if (!commentAtCursor) {
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
        return;
      }

      // Load VCM comments to check flags
      const { allComments: comments } = await readBothVCMs(relativePath);

      let isAlwaysShowFlag = false;
      let isPrivate = false;

      const currentKey = buildContextKey(commentAtCursor);

      // Check if any VCM comment with this context key has alwaysShow or isPrivate
      for (const c of comments) {
        const vcmKey = buildContextKey(c);
        if (vcmKey === currentKey) {
          if (isAlwaysShow(c)) isAlwaysShowFlag = true;
          if (c.isPrivate) isPrivate = true;
        }
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