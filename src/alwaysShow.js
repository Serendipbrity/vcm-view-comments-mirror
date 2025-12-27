const vscode = require("vscode");
const { buildContextKey } = require("./buildContextKey");

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
      const commentAtCursor = docComments.find(curr => {
        if (curr.type === "inline") {
          return curr.commentedLineIndex === selectedLine;
        } else if (curr.type === "block" && curr.block) {
          return curr.block.some(b => b.commentedLineIndex === selectedLine);
        }
        return false;
      });

      // Set cursorOnComment based on whether we found a comment
      await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', !!commentAtCursor);

      if (!commentAtCursor) {
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
        await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
        return;
      }

      // Load VCM comments to check flags
      const { allComments: comments } = await readBothVCMs(relativePath);

      let isAlwaysShow = false;
      let isPrivate = false;

      const currentKey = buildContextKey(commentAtCursor);

      // Check if any VCM comment with this context key has alwaysShow or isPrivate
      for (const c of comments) {
        const vcmKey = buildContextKey(c);
        if (vcmKey === currentKey) {
          if (c.alwaysShow) isAlwaysShow = true;
          if (c.isPrivate) isPrivate = true;
        }
      }

      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', isAlwaysShow);
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
};