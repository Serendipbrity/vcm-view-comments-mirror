// ==============================================================================
// Split View Manager
// ==============================================================================
// Handles all split-view related functionality:
// - Watchers that refresh split view on document change
// - Helper to update split view manually
// ==============================================================================

const vscode = require("vscode");
const { mergeSharedTextCleanMode } = require("../utils_copycode/mergeTextCleanMode");
const { injectComments, stripComments } = require("../helpers_subroutines/injectExtractComments");
const { generateCommentedVersion } = require("../helpers_subroutines/generateCommentedVersion");
// ---------------------------------------------------------------------------
// Helper: Generate commented version (for split view when source is in clean mode)
// ---------------------------------------------------------------------------
async function generateCommentedSplitView(text, filePath, relativePath, readSharedVCM, vcmDir) {
  return await generateCommentedVersion(text, filePath, relativePath, readSharedVCM, vcmDir);
}

// ---------------------------------------------------------------------------
// Helper function to close split view tab and clean up
// ---------------------------------------------------------------------------
async function closeSplitView(getSplitViewState, commentJumpIndexCache = null) {
  const { tempUri, setSplitViewState } = getSplitViewState();

  if (tempUri) {
    try {
      // Clean up cache entry to prevent memory leak
      if (commentJumpIndexCache) {
        commentJumpIndexCache.delete(tempUri.toString());
      }

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
function setupSplitViewWatchers(context, provider, getSplitViewState, readSharedVCM, readPrivateVCM, detectInitialMode, detectPrivateVisibility, commentJumpIndexCache = null) {

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
        const { isCommentedMap, privateCommentsVisible, vcmDir, vcmPrivateDir, tempUri: currentTempUri } = getSplitViewState();

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
          const sharedComments = await readSharedVCM(relativePath, vcmDir);
          const privateComments = await readPrivateVCM(relativePath, vcmPrivateDir);
          const mergedShared = mergeSharedTextCleanMode(sharedComments);

          // Step 1: Strip shared comments (stripComments automatically preserves alwaysShow)
          let cleanVersion = stripComments(text, doc.uri.path, mergedShared);

          // Step 2: If private is OFF, strip private using private VCM (not parsed from doc)
          if (!includePrivate) {
            cleanVersion = stripComments(cleanVersion, doc.uri.path, privateComments);
          }

          showVersion = cleanVersion;
        } else {
          // Source is in clean mode, show commented in split view
          showVersion = await generateCommentedSplitView(text, doc.uri.path, relativePath, readSharedVCM, vcmDir);
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
      closeSplitView(getSplitViewState, commentJumpIndexCache);
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
        closeSplitView(getSplitViewState, commentJumpIndexCache);
      }
    }
  });
  context.subscriptions.push(visibleEditorsWatcher);
}

// ---------------------------------------------------------------------------
// Update split view manually
// ---------------------------------------------------------------------------
// Parameters:
// - privateVisibilityOverride: if provided (not undefined), use this explicit private visibility state (for toggle private)
// - Otherwise (undefined): read current state from privateCommentsVisible map (for full rebuild)
async function updateSplitViewIfOpen(
  doc,
  provider,
  relativePath,
  getSplitViewState,
  readSharedVCM,
  readPrivateVCM,
  privateVisibilityOverride = undefined
) {
  const { tempUri, vcmEditor, sourceDocUri, isCommentedMap, privateCommentsVisible } = getSplitViewState();

  // Manually update split view if it's open
  if (tempUri && vcmEditor && sourceDocUri && doc.uri.toString() === sourceDocUri.toString()) {
    try {
      const includePrivate =
        privateVisibilityOverride !== undefined
          ? privateVisibilityOverride
          : (privateCommentsVisible.get(doc.uri.fsPath) === true);

      if (privateVisibilityOverride !== undefined) {
        // PRIVATE-ONLY UPDATE: operate ONLY on private comments, do NOT parse, do NOT rebuild
        const currentSplitContent = provider.content.get(tempUri.toString()) || "";

        // We only need private comments for this operation.
        const { vcmPrivateDir } = getSplitViewState();
        const privateComments = await readPrivateVCM(relativePath, vcmPrivateDir);

        let updatedSplitContent;

        if (includePrivate) {
          // Make it idempotent:
          // 1) remove any existing private comments (prevents double injection)
          // 2) inject private comments exactly once
          const withoutPrivate = stripComments(currentSplitContent, doc.uri.path, privateComments);
          updatedSplitContent = injectComments(withoutPrivate, doc.uri.path, privateComments, true, true);
        } else {
          // Private OFF: strip private comments only
          updatedSplitContent = stripComments(currentSplitContent, doc.uri.path, privateComments);
        }

        provider.update(tempUri, updatedSplitContent);
        return; // IMPORTANT: do not fall through to full rebuild
      }

      // FULL UPDATE: Rebuild from VCM (existing behavior)
      const updatedText = doc.getText();
      const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);

      let showVersion;
      if (isInCommentedMode) {
        // Source is in commented mode, show clean in split view
        const { vcmDir, vcmPrivateDir } = getSplitViewState();
        const sharedComments = await readSharedVCM(relativePath, vcmDir);
        const privateComments = await readPrivateVCM(relativePath, vcmPrivateDir);
        const mergedShared = mergeSharedTextCleanMode(sharedComments);

        // Step 1: Strip shared comments (stripComments automatically preserves alwaysShow)
        let cleanVersion = stripComments(updatedText, doc.uri.path, mergedShared);

        // Step 2: If private is OFF, strip private using private VCM (not parsed from doc)
        if (!includePrivate) {
      
          cleanVersion = stripComments(cleanVersion, doc.uri.path, privateComments);
        }

        showVersion = cleanVersion;
      } else {
        // Source is in clean mode, show commented in split view
        const { vcmDir } = getSplitViewState();
        showVersion = await generateCommentedSplitView(
          updatedText,
          doc.uri.path,
          relativePath,
          readSharedVCM,
          vcmDir
        );
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
