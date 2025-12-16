const vscode = require("vscode");
const { getCommentMarkersForFile } = require("./commentMarkers");
const { loadAllVCMComments } = require("./loadAllVCMComments");

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

      // Check if any comment with this anchor has alwaysShow or isPrivate
      let isAlwaysShow = false;
      let isPrivate = false;
      for (const c of comments) {
        if (c.anchor === anchorHash) {
          // For inline comments, also verify we're on the correct line
          if (c.type === "inline" && isInlineComment) {
            // Extract current comments and match by line
            const docComments = buildVCMObjects(doc.getText(), doc.uri.path);
            const matchingCurrent = docComments.find(curr =>
              curr.anchor === anchorHash && curr.originalLineIndex === selectedLine
            );
            if (matchingCurrent) {
              if (c.alwaysShow) isAlwaysShow = true;
              if (c.isPrivate) isPrivate = true;
            }
          } else {
            // For block comments, anchor match is sufficient
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