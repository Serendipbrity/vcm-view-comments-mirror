// ==============================================================================
// Split View Manager
// ==============================================================================
// Handles all split-view related functionality:
// - Watchers that refresh split view on document change
// - Helper to update split view manually
// ==============================================================================

const vscode = require("vscode");
const { mergeSharedTextCleanMode } = require("../mergeTextCleanMode");
const { loadAllVCMComments } = require("../vcm/loadAllVCMComments");
// ---------------------------------------------------------------------------
// Helper: Generate commented version (for split view)
// ---------------------------------------------------------------------------
async function generateCommentedSplitView(text, filePath, relativePath, includePrivate, loadAllVCMComments) {
  const { stripComments, injectComments } = require("../injectExtractComments");

  try {
    // Load ALL comments (shared + private) to handle includePrivate correctly
    const { sharedComments, privateComments } = await loadAllVCMComments(relativePath);

    // Merge text_cleanMode into text/block (but don't modify the original) for shared comments
    const mergedSharedComments = mergeSharedTextCleanMode(sharedComments);

    // Combine shared and private comments (all need to be in array for proper filtering)
    const allComments = [...mergedSharedComments, ...privateComments];

    // Strip ALL comments from source (both shared and private) before injecting
    // We want a clean slate, then inject only what's needed based on includePrivate
    const cleanText = stripComments(text, filePath, allComments, false, true);
    return injectComments(cleanText, allComments, includePrivate);
  } catch {
    // No .vcm file exists
    return text;
  }
}

// ---------------------------------------------------------------------------
// Helper function to close split view tab and clean up
// ---------------------------------------------------------------------------
async function closeSplitView(getSplitViewState) {
  const { tempUri, setSplitViewState } = getSplitViewState();

  if (tempUri) {
    try {
      // Find the specific VCM tab and close only that tab (not the whole pane)
      const allTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
      const vcmTab = allTabs.find(tab => {
        if (tab.input instanceof vscode.TabInputText) {
          return tab.input.uri.toString() === tempUri.toString();
        }
        return false;
      });

      if (vcmTab) {
        await vscode.window.tabGroups.close(vcmTab);
      }
    } catch {
      // ignore errors if already closed
    }
  }

  // Clean up references via setState
  setSplitViewState({
    vcmEditor: null,
    tempUri: null,
    sourceDocUri: null,
    scrollListener: null
  });
}

// ---------------------------------------------------------------------------
// Setup split view watchers
// ---------------------------------------------------------------------------
function setupSplitViewWatchers(context, provider, getSplitViewState, loadAllVCMComments, detectInitialMode, detectPrivateVisibility) {
  const { stripComments } = require("../injectExtractComments");

  // Split view live sync: update the VCM split view when source file changes
  let splitViewUpdateTimeout;
  const splitViewSyncWatcher = vscode.workspace.onDidChangeTextDocument(async (e) => {
    // Get initial state to check if split view is open
    const initialState = getSplitViewState();
    const { vcmEditor, tempUri, sourceDocUri } = initialState;

    // Only sync if split view is open
    if (!vcmEditor || !tempUri || !sourceDocUri) return;

    // Only sync changes to the source document (not the vcm-view: document)
    if (e.document.uri.scheme === "vcm-view") return;

    // Only sync if this is the document that has the split view open
    if (e.document.uri.toString() !== sourceDocUri.toString()) return;

    const doc = e.document;
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    // Check if this is an undo/redo operation
    const isUndoRedo = e.reason === vscode.TextDocumentChangeReason.Undo ||
                       e.reason === vscode.TextDocumentChangeReason.Redo;

    // Debounce updates to prevent multiple rapid changes
    clearTimeout(splitViewUpdateTimeout);
    splitViewUpdateTimeout = setTimeout(async () => {
      try {
        // Get fresh state inside timeout to ensure we have latest references
        const { isCommentedMap, privateCommentsVisible, vcmDir, tempUri: currentTempUri } = getSplitViewState();

        // Get updated text from the document (source of truth)
        const text = doc.getText();

        let actualMode;
        const storedMode = isCommentedMap.get(doc.uri.fsPath);

        // Only detect mode on undo/redo/paste (might have changed modes)
        // For normal typing, use stored mode (typing in clean mode stays in clean mode)
        if (isUndoRedo) {
          actualMode = await detectInitialMode(doc, vcmDir);
          if (storedMode !== actualMode) {
            isCommentedMap.set(doc.uri.fsPath, actualMode);
          } else {
            actualMode = storedMode;
          }

          // Also detect private visibility on undo/redo
          const actualPrivateVisibility = await detectPrivateVisibility(doc, relativePath);
          const storedPrivateVisibility = privateCommentsVisible.get(doc.uri.fsPath);
          if (storedPrivateVisibility !== actualPrivateVisibility) {
            privateCommentsVisible.set(doc.uri.fsPath, actualPrivateVisibility);
          }
        } else {
          actualMode = storedMode;
        }

        // Get current private visibility state
        const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;

        let showVersion;
        if (actualMode) {
          // Source is in commented mode, show clean in split view
          // Load VCM comments to preserve alwaysShow metadata
          const { allComments: vcmComments } = await loadAllVCMComments(relativePath);
          showVersion = stripComments(text, doc.uri.path, vcmComments, includePrivate);
        } else {
          // Source is in clean mode, show commented in split view
          // Use the same logic as toggling to commented mode
          showVersion = await generateCommentedSplitView(text, doc.uri.path, relativePath, includePrivate, loadAllVCMComments);
        }

        // Update the split view content
        provider.update(currentTempUri, showVersion);
      } catch (err) {
        // Ignore errors - VCM might not exist yet
      }
    }, 300); // Longer debounce to handle rapid undo/redo operations
  });
  context.subscriptions.push(splitViewSyncWatcher);

  // Clean up when split view is closed
  const closeWatcher = vscode.workspace.onDidCloseTextDocument((doc) => {
    const { tempUri, sourceDocUri, setSplitViewState } = getSplitViewState();

    if (tempUri && doc.uri.toString() === tempUri.toString()) {
      // Split view document was closed
      setSplitViewState({
        vcmEditor: null,
        tempUri: null,
        sourceDocUri: null,
        scrollListener: null
      });
    } else if (sourceDocUri && doc.uri.toString() === sourceDocUri.toString()) {
      // Source document was closed - close the split view too
      closeSplitView(getSplitViewState);
    }
  });
  context.subscriptions.push(closeWatcher);

  // Monitor visible editors - close split view if source is no longer visible
  const visibleEditorsWatcher = vscode.window.onDidChangeVisibleTextEditors((editors) => {
    const { sourceDocUri, tempUri } = getSplitViewState();

    // If we have a split view open, check if source is still visible
    if (sourceDocUri && tempUri) {
      const sourceVisible = editors.some(e => e.document.uri.toString() === sourceDocUri.toString());
      if (!sourceVisible) {
        // Source is no longer visible - close the split view
        closeSplitView(getSplitViewState);
      }
    }
  });
  context.subscriptions.push(visibleEditorsWatcher);
}

// ---------------------------------------------------------------------------
// Update split view manually (called from toggle private comments)
// ---------------------------------------------------------------------------
async function updateSplitViewIfOpen(doc, provider, relativePath, getSplitViewState, loadAllVCMComments) {
  const { stripComments } = require("../injectExtractComments");
  const { tempUri, vcmEditor, sourceDocUri, isCommentedMap, privateCommentsVisible } = getSplitViewState();

  // Manually update split view if it's open
  if (tempUri && vcmEditor && sourceDocUri && doc.uri.toString() === sourceDocUri.toString()) {
    try {
      const updatedText = doc.getText();
      const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);
      const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;

      let showVersion;
      if (isInCommentedMode) {
        // Source is in commented mode, show clean in split view
        const { allComments: vcmComments } = await loadAllVCMComments(relativePath);
        showVersion = stripComments(updatedText, doc.uri.path, vcmComments, includePrivate);
      } else {
        // Source is in clean mode, show commented in split view
        showVersion = await generateCommentedSplitView(updatedText, doc.uri.path, relativePath, includePrivate);
      }

      provider.update(tempUri, showVersion);
    } catch {
      // Ignore errors
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
module.exports = {
  setupSplitViewWatchers,
  updateSplitViewIfOpen,
  closeSplitView,
};
