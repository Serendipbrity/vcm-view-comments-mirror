const vscode = require("vscode");
const { getCommentMarkersForFile } = require("./commentMarkers");
const { buildContextKey } = require("./buildContextKey");

async function updateAlwaysShowContext({ loadAllVCMComments, buildVCMObjects, hashLine }) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', false);
      return;
    }

    const doc = editor.document;
    const selectedLine = editor.selection.active.line;
    const line = doc.lineAt(selectedLine);
    const text = line.text;
    const trimmed = text.trim();

    // Check if cursor is on a comment line (either block comment or inline comment)
    const isBlockComment = trimmed.match(/^(\s*)(#|\/\/|--|%|;)/);
    const commentMarkers = getCommentMarkersForFile(doc.uri.path);
    let isInlineComment = false;

    // Check if line contains an inline comment
    if (!isBlockComment) {
      for (const marker of commentMarkers) {
        const markerIndex = text.indexOf(marker);
        if (markerIndex > 0) {
          // Comment marker appears after position 0, so it's inline
          isInlineComment = true;
          break;
        }
      }
    }

    const isOnComment = isBlockComment || isInlineComment;
    await vscode.commands.executeCommand('setContext', 'vcm.cursorOnComment', !!isOnComment);

    if (!isOnComment) {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
      return;
    }

    // Check if this comment is marked as alwaysShow or private
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    try {
      const { allComments: comments } = await loadAllVCMComments(relativePath);

      // Find the anchor hash for this comment
      const lines = doc.getText().split("\n");
      let anchorHash;

      if (isInlineComment) {
        // For inline comments, the anchor is the code portion before the comment
        // Find where the comment starts and hash only the code part
        let commentStartIndex = -1;
        for (const marker of commentMarkers) {
          const markerRegex = new RegExp(`(\\s+)(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
          const match = text.match(markerRegex);
          if (match) {
            commentStartIndex = match.index;
            break;
          }
        }
        if (commentStartIndex > 0) {
          const anchorBase = text.substring(0, commentStartIndex).trimEnd();
          anchorHash = hashLine(anchorBase, 0);
        } else {
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
          return;
        }
      } else {
        // For block comments, find the next non-comment line
        let anchorLineIndex = -1;
        for (let i = selectedLine + 1; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
            anchorLineIndex = i;
            break;
          }
        }

        // If no code line below, fallback to the previous code line
        if (anchorLineIndex === -1) {
          for (let i = selectedLine - 1; i >= 0; i--) {
            const trimmed = lines[i].trim();
            if (trimmed && !trimmed.match(/^(\s*)(#|\/\/|--|%|;)/)) {
              anchorLineIndex = i;
              break;
            }
          }
        }

        if (anchorLineIndex === -1) {
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
          await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
          return;
        }

        anchorHash = hashLine(lines[anchorLineIndex], 0);
      }

      // Check if any comment with matching context has alwaysShow or isPrivate
      let isAlwaysShow = false;
      let isPrivate = false;

      // Extract current comments to get context keys
      const docComments = buildVCMObjects(doc.getText(), doc.uri.path);

      // Find the comment at the current cursor position
      const commentAtCursor = docComments.find(curr => {
        if (isInlineComment) {
          return curr.type === "inline" && curr.anchor === anchorHash && curr.originalLineIndex === selectedLine;
        } else {
          // For block comments, find the block that contains this line
          if (curr.type === "block" && curr.block) {
            return curr.block.some(b => b.originalLineIndex === selectedLine);
          }
          return false;
        }
      });

      if (commentAtCursor) {
        const currentKey = buildContextKey(commentAtCursor);

        // Check if any VCM comment with this context key has alwaysShow or isPrivate
        for (const c of comments) {
          const vcmKey = buildContextKey(c);
          if (vcmKey === currentKey) {
            if (c.alwaysShow) isAlwaysShow = true;
            if (c.isPrivate) isPrivate = true;
          }
        }
      }

      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', isAlwaysShow);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', isPrivate);
    } catch {
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow', false);
      await vscode.commands.executeCommand('setContext', 'vcm.commentIsPrivate', false);
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