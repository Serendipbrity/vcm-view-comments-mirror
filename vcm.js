// ==============================================================================
// VCM (Visual Comment Manager) Extension for VS Code
// ==============================================================================
// This extension provides multiple modes for managing comments in source code:
// 1. Split view: Source on left, clean/commented version on right
// 2. Single file toggle: Hide/show comments in the same file
// 3. Persistent storage: Comments saved to .vcm directory for reconstruction
// ==============================================================================

const vscode = require("vscode"); // vs code api module. lets us talk to and control VSCode itself
const { getCommentMarkersForFile } = require("./src/commentMarkers");
const { VCMContentProvider } = require("./src/split_view/contentProvider");
const { hashLine } = require("./src/hash");
const { injectComments, stripComments } = require("./src/injectExtractComments");
const { parseDocComs } = require("./src/vcm/parseDocComs");
const { syncCommentsToVCMs } = require("./src/vcm/syncCommentsToVCMs");
const { createDetectors } = require("./src/detectModes");
const { buildContextKey } = require("./src/buildContextKey");
const { setupSplitViewWatchers, updateSplitViewIfOpen, closeSplitView } = require("./src/split_view/splitViewManager");
const { loadAllVCMComments } = require("./src/vcm/loadAllVCMComments");
const { vcmFileExists } = require("./src/vcm/vcmFileExists");
const { createVCMFiles } = require("./src/vcm/createVCMFiles");

// Global state variables for the extension
let vcmEditor;           // Reference to the VCM split view editor
let tempUri;             // URI for the temporary VCM view document
let scrollListener;      // Event listener for cursor movement between panes
let sourceDocUri;        // Track which source document has the split view open
let vcmSyncEnabled = true; // Flag to temporarily disable .vcm file updates during toggles
// Map is a Class for storing key value pairs. 
// new Map creates an empty instance to use crud on
// maps are better than objects because the key doesnt have to be a string and it keeps the key value ordering that they were added in. 
// What 'new' does under the hood:
// 1 Creates a fresh empty object: {}
// 2 Links that object’s internal prototype to the constructor’s .prototype.
// 3 Runs the constructor function, binding this to that new object.
// 4 Returns the new object automatically.
let isCommentedMap = new Map(); // Cached current mode: clean vs commented.true = commented, false = clean
// Set is a Class for storing unique values of any type
// its a hash table
// duplicates get auto removed
// order of insertion is preserved
// fast lookups. has() is O(1)
// Hash based. Not index based/accessed
let justInjectedFromVCM = new Set(); // Track files that just had VCM comments injected (don't re-extract)
let privateCommentsVisible = new Map(); // Track private comment visibility per file: true = visible, false = hidden


// -----------------------------------------------------------------------------
// Extension Activate
// -----------------------------------------------------------------------------

// Capture a fresh timestamp for each activation so logs show when the extension loaded
const buildTag = (() => {
  const iso = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  return iso.replace("T", "-");
})();

async function activate(context) {
  console.log("VCM ACTIVATE", {
    buildTag,
    cwd: process.cwd(),
    extensionPath: context.extensionPath,
  });
  // --- RESET ALL IN-MEMORY STATE ON ACTIVATE to remove stale flags ------------------------------
  try {
    console.log("BEFORE clearing:", {
    isCommentedMap: Array.from(isCommentedMap.entries()),
    privateCommentsVisible: Array.from(privateCommentsVisible.entries()),
    justInjectedFromVCM: Array.from(justInjectedFromVCM.values())
    });

    isCommentedMap.clear();
    privateCommentsVisible.clear();
    justInjectedFromVCM.clear();

    console.log("AFTER clearing:", {
        isCommentedMap: Array.from(isCommentedMap.entries()),
        privateCommentsVisible: Array.from(privateCommentsVisible.entries()),
        justInjectedFromVCM: Array.from(justInjectedFromVCM.values())
    });
  } catch (err) {
      console.warn("VCM: Failed to clear state on activate()", err);
  }
  // ------------------------------------------------------------------------

  // Load user configuration
  const config = vscode.workspace.getConfiguration("vcm");
  const liveSync = config.get("liveSync", false);       // Auto-save .vcm on edit
  const debugAnchorText = config.get("debugAnchorText", true); // Store anchor line text for debugging

  // Create .vcm directory in workspace root
  // This stores .vcm.json files that mirror the comment structure
  const vcmBaseDir = vscode.Uri.joinPath(
    vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(process.cwd()),
    ".vcm"
  );
  const vcmDir = vscode.Uri.joinPath(vcmBaseDir, "shared");
  const vcmPrivateDir = vscode.Uri.joinPath(vcmBaseDir, "private");

  // Don't auto-create directories - they'll be created when first needed

  // Register content provider for vcm-view: scheme
  // This allows us to create virtual documents that display in the editor
  const provider = new VCMContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("vcm-view", provider)
  );
  const { updateAlwaysShow } = require("./src/alwaysShow");
  // TODO: might need to move this lower in the file but seems to be working fine rn
  const deps = { loadAllVCMComments: (relativePath) => loadAllVCMComments(relativePath, vcmDir), parseDocComs, hashLine };

  const { mergeSharedTextCleanMode } = require("./src/mergeTextCleanMode");

  // ---------------------------------------------------------------------------
  // Update context for menu items based on cursor position
  // ---------------------------------------------------------------------------
  // Update context when selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => updateAlwaysShow(context, deps))
  );

  // Update context when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateAlwaysShow(context, deps))
  );

  // Initial update
  updateAlwaysShow(context, deps);

  

  const { detectInitialMode, detectPrivateVisibility } = createDetectors({
    loadAllVCMComments: (relativePath) => loadAllVCMComments(relativePath, vcmDir),
    parseDocComs,
    vscode,
  });

  // ============================================================================
  // saveVCM()
  // ============================================================================
  // Handles saving the .vcm mirror file for the currently open document.
  // Logic:
  //   - If the file contains existing VCM comments (isCommented = true):
  //         → overwrite the .vcm.json with the current comment state.
  //   - If the file is clean (isCommented = false):
  //         → prepend new comments to existing ones where possible,
  //           without overwriting anything in the .vcm.json.
  //
  // GATING POLICY (allowCreate parameter):
  // stop auto vcm creation on save unless explicitly toggling vcm or marking comments
  // - allowCreate = false (default): Only updates existing VCM files. If no VCM
  //   exists, this function does nothing. Use for auto-save/liveSync paths.
  // - allowCreate = true: Creates VCM if missing, or updates if exists. Use for
  //   explicit VCM actions (toggles, split view, etc.).
  // ============================================================================
  async function saveVCM(doc, allowCreate = false) {
    if (doc.uri.scheme !== "file") return;
    if (doc.uri.path.includes("/.vcm/")) return;
    if (doc.languageId === "json") return;

    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    // 🔑 GATING LOGIC: Check if VCM files exist before proceeding
    const sharedExists = await vcmFileExists(vcmDir, relativePath);
    const privateExists = await vcmFileExists(vcmPrivateDir, relativePath);
    const anyVcmExists = sharedExists || privateExists;

    // Core rule: If this is NOT an explicit VCM action (allowCreate === false)
    // AND no VCM exists yet → do nothing. Don't create one.
    if (!allowCreate && !anyVcmExists) {
      console.log(`[saveVCM] Skipping ${relativePath} - no VCM exists and allowCreate=false`);
      return;
    }

    // Check if we just injected comments from VCM
    // (this flag prevents re-extracting immediately after injection in clean mode)
    const wasJustInjected = justInjectedFromVCM.has(doc.uri.fsPath);
    if (wasJustInjected) {
      justInjectedFromVCM.delete(doc.uri.fsPath);
    }

    const text = doc.getText();

    // Load existing VCM data from both shared and private files
    const { sharedComments: vcmComments, privateComments: existingPrivateComments } = await loadAllVCMComments(relativePath, vcmDir);

    // Get the current mode from our state map
    // IMPORTANT: Once mode is set, it should NEVER change except via manual toggle or undo/redo
    let isCommented = isCommentedMap.get(doc.uri.fsPath);
    console.log(`activate: saveVCM for ${relativePath}, wasJustInjected=${wasJustInjected}, isCommented=${isCommented}`);
    // If state is not set, initialize it by detecting the mode
    // This only happens on first open or after a restart
    if (isCommented === undefined) {
      isCommented = await detectInitialMode(doc, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, isCommented);
    }

    // Initialize private comment visibility if not set
    // After initialization, state is managed by toggles and undo/redo detection (same as commented mode)
    if (!privateCommentsVisible.has(doc.uri.fsPath)) {
      const privateVisible = await detectPrivateVisibility(doc, relativePath);
      privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
    }

    // Debug: Never re-detect mode during normal saves - mode should be stable
    // Both commented/clean mode AND private visibility are managed by toggles and undo/redo detection

    // Extract all current comments from the document
    // Pass mode and ALL existing comments (shared + private) so blank lines are handled correctly
    // This is critical for proper matching when private comments are visible in clean mode
    const isCleanMode = !isCommented;
    const allvcmComments = [...vcmComments, ...existingPrivateComments];
    const docComments = parseDocComs(text, doc.uri.path, allvcmComments, isCleanMode, debugAnchorText);

    // ------------------------------------------------------------------------
    // Merge Strategy - Using syncCommentsToVCMs for both shared and private
    // ------------------------------------------------------------------------

    // Process shared comments (these may include isPrivate flags in commented mode)
    let finalComments = syncCommentsToVCMs({
      isCommented,
      docComments,
      vcmComments,
      otherVCMComments: existingPrivateComments,
      isPrivateMode: false,
      wasJustInjected,
    });

    // Process private comments (updates anchors and content)
    syncCommentsToVCMs({
      isCommented,
      docComments,
      vcmComments: existingPrivateComments,
      otherVCMComments: vcmComments,
      isPrivateMode: true,
      wasJustInjected,
    });

    // ------------------------------------------------------------------------
    // Filter out empty comments (no text, block, or text_cleanMode content)
    // ------------------------------------------------------------------------
    finalComments = finalComments.filter(comment => {
      // For inline comments: must have text or text_cleanMode
      if (comment.type === 'inline') {
        return (comment.text && comment.text.trim()) ||
               (comment.text_cleanMode && comment.text_cleanMode.trim());
      }
      // For block comments: must have block or text_cleanMode with content
      else if (comment.type === 'block') {
        const hasBlock = comment.block && Array.isArray(comment.block) && comment.block.length > 0;
        const hasTextCleanMode = comment.text_cleanMode && Array.isArray(comment.text_cleanMode) && comment.text_cleanMode.length > 0;
        return hasBlock || hasTextCleanMode;
      }
      return true;
    });

    // ------------------------------------------------------------------------
    // Save final comments, splitting into shared and private files
    // ------------------------------------------------------------------------
    // In commented mode: private comments are extracted and already in finalComments with isPrivate: true
    // In clean mode: private comments were processed separately and updated in place (text-based matching)

    // Check which private comments are already in finalComments (using text+anchor+type as key)
    // In commented mode: private comments were extracted and marked with isPrivate
    // In clean mode: private comments were updated separately via text-based matching
    const finalCommentsSet = new Set(finalComments.map(c => {
      const text = c.text || (c.block ? c.block.map(b => b.text).join('\n') : '');
      return `${c.type}:${c.anchor}:${text}`;
    }));

    // Add private comments that aren't already in finalComments
    // (They might already be there if private comments were visible and got extracted)
    const missingPrivateComments = existingPrivateComments.filter(pc => {
      const text = pc.text || (pc.block ? pc.block.map(b => b.text).join('\n') : '');
      const key = `${pc.type}:${pc.anchor}:${text}`;
      return !finalCommentsSet.has(key);
    }).map(pc => ({ ...pc, isPrivate: true })); // Ensure isPrivate flag is set

    const finalCommentsWithPrivate = [...finalComments, ...missingPrivateComments];
    await createVCMFiles(relativePath, finalCommentsWithPrivate, vcmDir);
  }

  // ---------------------------------------------------------------------------
  // WATCHERS
  // ---------------------------------------------------------------------------

  // Watch for file saves and update .vcm files
  // vcmSyncEnabled flag prevents infinite loops during toggles
  const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!vcmSyncEnabled) return;  // Skip if we're in the middle of a toggle
    // allowCreate = false (default): only update existing VCM files, don't create new ones
    await saveVCM(doc);
  });
  context.subscriptions.push(saveWatcher);

  // Optional: Watch for file edits and auto-save .vcm after 2 seconds
  // This provides real-time .vcm updates but can be disabled for performance
  if (liveSync) {
    let writeTimeout;
    const changeWatcher = vscode.workspace.onDidChangeTextDocument((e) => {
      if (!vcmSyncEnabled) return;
      // allowCreate = false (default): only update existing VCM files, don't create new ones
      clearTimeout(writeTimeout);
      writeTimeout = setTimeout(() => saveVCM(e.document), 2000);
    });
    context.subscriptions.push(changeWatcher);
  }


  // Setup split view watchers (moved to splitViewManager)
  // Helper to get/set split view state
  const getSplitViewState = () => ({
    vcmEditor,
    tempUri,
    sourceDocUri,
    scrollListener,
    isCommentedMap,
    privateCommentsVisible,
    vcmDir,
    setSplitViewState: (state) => {
      if (state.vcmEditor !== undefined) vcmEditor = state.vcmEditor;
      if (state.tempUri !== undefined) tempUri = state.tempUri;
      if (state.sourceDocUri !== undefined) sourceDocUri = state.sourceDocUri;
      if (state.scrollListener !== undefined) {
        if (scrollListener) scrollListener.dispose();
        scrollListener = state.scrollListener;
      }
    }
  });

  setupSplitViewWatchers(
    context,
    provider,
    getSplitViewState,
    (relativePath) => loadAllVCMComments(relativePath, vcmDir),
    detectInitialMode,
    detectPrivateVisibility
  );

  // ---------------------------------------------------------------------------
  // COMMAND: Toggle same file (hide/show comments)
  // ---------------------------------------------------------------------------
  // Toggles comments on/off in the current file without creating a split view
  // Process:
  // 1. If file has comments: strip them and show clean version
  // 2. If file is clean: restore comments from .vcm file
  
  const toggleCurrentFileComments = vscode.commands.registerCommand("vcm-view-comments-mirror.toggleCurrentFileComments", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // Disable .vcm sync during toggle to prevent overwriting
    vcmSyncEnabled = false;

    const doc = editor.document;
    const text = doc.getText();
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    // Detect initial state if not already set
    if (!isCommentedMap.has(doc.uri.fsPath)) {
      const initialState = await detectInitialMode(doc, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, initialState);
    }

    // Detect private comment visibility if not already set
    if (!privateCommentsVisible.has(doc.uri.fsPath)) {
      const privateVisible = await detectPrivateVisibility(doc, relativePath);
      privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
    }

    // Get current state
    const currentIsCommented = isCommentedMap.get(doc.uri.fsPath);
    let newText;

    if (currentIsCommented === true) {
      // Currently in commented mode -> switch to clean mode (hide comments)
      // If no VCM exists yet, create it immediately so the first toggle succeeds
      const sharedExistsBootstrap = await vcmFileExists(vcmDir, relativePath);
      const privateExistsBootstrap = await vcmFileExists(vcmPrivateDir, relativePath);
      if (!sharedExistsBootstrap && !privateExistsBootstrap) {
        const extractedBootstrap = parseDocComs(text, doc.uri.path);
        await createVCMFiles(relativePath, extractedBootstrap, vcmDir);
      }

      // Ensure a .vcm file exists before stripping
      const vcmExists = await vcmFileExists(vcmDir, relativePath);
      if (!vcmExists) {
        // No .vcm yet — extract and save before removing comments
        // We're still in commented mode here, so this will extract all comments
        await saveVCM(doc, true); // allowCreate = true for explicit toggle action
      }

      // If liveSync is disabled, always update manually
      // We're still in commented mode here, so this will extract all comments
      const config = vscode.workspace.getConfiguration("vcm");
      const liveSync = config.get("liveSync", false);
      if (!liveSync) {
        await saveVCM(doc, true); // allowCreate = true for explicit toggle action
      }

      // Load ALL VCM comments (shared + private) to check for alwaysShow and isPrivate
      const { allComments: vcmComments } = await loadAllVCMComments(relativePath, vcmDir);

      // Strip comments to show clean version (but keep alwaysShow and private if visible)
      const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
      newText = stripComments(text, doc.uri.path, vcmComments, keepPrivate);
      // Mark this file as now in clean mode
      isCommentedMap.set(doc.uri.fsPath, false);
      // DO NOT change privateCommentsVisible - private comment visibility persists across mode toggles
      vscode.window.showInformationMessage("VCM: Switched to clean mode (comments hidden)");
    } else {
      // Currently in clean mode -> switch to commented mode (show comments)
      try {
        // Load ALL comments (shared + private) to handle includePrivate correctly
        const { sharedComments: existingSharedComments, privateComments: existingPrivateComments } = await loadAllVCMComments(relativePath, vcmDir);

        // Merge text_cleanMode into text/block and clear text_cleanMode for shared comments
        const mergedSharedComments = mergeSharedTextCleanMode(existingSharedComments);

        // # TODO: these few lines are in multiple places
        // Combine shared and private comments (all need to be in the array for proper filtering)
        const allMergedComments = [...mergedSharedComments, ...existingPrivateComments];

        // Strip any comments typed in clean mode before injecting VCM comments
        const cleanText = stripComments(text, doc.uri.path, allMergedComments, false);
        const includePrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
        newText = injectComments(cleanText, allMergedComments, includePrivate);

        // Save the merged shared comments back to VCM (using createVCMFiles for consistency)
        // Combine shared and private, preserving private comments unchanged
        const commentsToSave = [
          ...mergedSharedComments,
          ...existingPrivateComments.map(c => ({ ...c, isPrivate: true }))
        ];
        await createVCMFiles(relativePath, commentsToSave, vcmDir);

        // Mark this file as now in commented mode
        isCommentedMap.set(doc.uri.fsPath, true);
        // DO NOT change privateCommentsVisible - private comment visibility persists across mode toggles

        // Mark that we just injected from VCM - don't re-extract on next save
        justInjectedFromVCM.add(doc.uri.fsPath);

        vscode.window.showInformationMessage("VCM: Switched to commented mode (comments visible)");
      } catch {
        // No .vcm file exists yet — create one now
        isCommentedMap.set(doc.uri.fsPath, true);
        // DO NOT initialize privateCommentsVisible - it will default to false (hidden) if not set
        await saveVCM(doc, true); // allowCreate = true for explicit toggle action
        try {
          // Load ALL comments (shared + private) after saving
          const { sharedComments, privateComments } = await loadAllVCMComments(relativePath, vcmDir);
          const allComments = [...sharedComments, ...privateComments];

          // Strip comments before injecting (except alwaysShow and private if visible)
          const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;
          const cleanText = stripComments(text, doc.uri.path, allComments, keepPrivate);
          newText = injectComments(cleanText, allComments, keepPrivate);

          // Mark that we just injected from VCM - don't re-extract on next save
          justInjectedFromVCM.add(doc.uri.fsPath);

          vscode.window.showInformationMessage("VCM: Created new .vcm and switched to commented mode");
        } catch {
          vscode.window.showErrorMessage("VCM: Could not create .vcm data — save the file once with comments.");
          vcmSyncEnabled = true;
          return;
        }
      }
    }

    // Replace entire document content
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
    await vscode.workspace.applyEdit(edit);
    await vscode.commands.executeCommand("workbench.action.files.save");

    // Re-enable sync after a delay to ensure save completes
    setTimeout(() => (vcmSyncEnabled = true), 800);
  });
  context.subscriptions.push(toggleCurrentFileComments);

  // ---------------------------------------------------------------------------
  // COMMAND: Right-click -> "Always Show This Comment"
  // ---------------------------------------------------------------------------
  const markAlwaysShow = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.markAlwaysShow",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Extract current comments and find the one at cursor position
        const docComments = parseDocComs(doc.getText(), doc.uri.path);

        // Find the comment at the selected line
        const commentAtCursor = docComments.find(c => {
          if (c.type === "inline") {
            return c.commentedLineIndex === selectedLine;
          } else if (c.type === "block" && c.block) {
            return c.block.some(b => b.commentedLineIndex === selectedLine);
          }
          return false;
        });

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: You can only mark comment lines as 'Always Show'.");
          return;
        }

        // Load or create VCM comments
        let comments = [];
        const { allComments, sharedComments } = await loadAllVCMComments(relativePath, vcmDir);

        // If no shared VCM exists - save all extracted comments
        if (!sharedComments || sharedComments.length === 0) {
          commentAtCursor.alwaysShow = true;
          comments = docComments;
        } else {
          // VCM exists - mark the comment in existing list using context matching
          comments = allComments;

          // Build context key for current comment
          const currentKey = buildContextKey(commentAtCursor);

          // Find matching VCM comment using context key
          const targetVcmComment = comments.find(c => buildContextKey(c) === currentKey);

          if (targetVcmComment) {
            targetVcmComment.alwaysShow = true;
          } else {
            // Comment not found in existing VCM - add it as a new entry with alwaysShow
            commentAtCursor.alwaysShow = true;
            comments.push(commentAtCursor);
          }
        }

        // Save updated comments
        await createVCMFiles(relativePath, comments, vcmDir);

        vscode.window.showInformationMessage("VCM: Marked as Always Show ✅");
        // Update context to refresh menu items
        await updateAlwaysShow(context, deps);
        // Manually update split view if it's open (using splitViewManager)
        await updateSplitViewIfOpen(
          doc,
          provider,
          relativePath,
          getSplitViewState,
          (relativePath) => loadAllVCMComments(relativePath, vcmDir)
        );
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error marking comment as Always Show: " + err.message);
      }
    }
  );
  context.subscriptions.push(markAlwaysShow);

  // ---------------------------------------------------------------------------
  // COMMAND: Right-click -> "Unmark Always Show"
  // ---------------------------------------------------------------------------
  const unmarkAlwaysShow = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.unmarkAlwaysShow",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Extract current comments and find the one at cursor position
        const docComments = parseDocComs(doc.getText(), doc.uri.path);

        // Find the comment at the selected line
        const commentAtCursor = docComments.find(c => {
          if (c.type === "inline") {
            return c.commentedLineIndex === selectedLine;
          } else if (c.type === "block" && c.block) {
            return c.block.some(b => b.commentedLineIndex === selectedLine);
          }
          return false;
        });

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: You can only unmark comment lines.");
          return;
        }

        // Load all comments using helper function
        const { allComments } = await loadAllVCMComments(relativePath, vcmDir);

        if (allComments.length === 0) {
          vscode.window.showWarningMessage("VCM: No .vcm file found.");
          return;
        }

        const comments = allComments;

        // Build context key for the comment at cursor
        const currentKey = buildContextKey(commentAtCursor);

        // Search for comment with matching context key and remove alwaysShow
        let found = false;
        for (const c of comments) {
          if (buildContextKey(c) === currentKey && c.alwaysShow) {
            delete c.alwaysShow;
            found = true;
            break;
          }
        }

        if (!found) {
          vscode.window.showWarningMessage("VCM: This comment is not marked as Always Show.");
          return;
        }

        // Save updated comments using helper function
        await createVCMFiles(relativePath, comments, vcmDir);

        // Check if we're in clean mode - if so, remove the comment from the document
        const isInCleanMode = isCommentedMap.get(doc.uri.fsPath) === false;

        if (isInCleanMode) {
          // Remove the comment line(s) from the document
          const edit = new vscode.WorkspaceEdit();

          const matchingComment = commentAtCursor;

          if (matchingComment) {
            if (matchingComment.type === "block" && matchingComment.block) {
              // Remove all lines in the block (from first to last)
              const firstLine = Math.min(...matchingComment.block.map(b => b.commentedLineIndex));
              const lastLine = Math.max(...matchingComment.block.map(b => b.commentedLineIndex));
              const range = new vscode.Range(firstLine, 0, lastLine + 1, 0);
              edit.delete(doc.uri, range);
            } else if (matchingComment.type === "inline") {
              // Remove just the inline comment part (keep the code)
              const lineText = doc.lineAt(matchingComment.commentedLineIndex).text;
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);

              // Find where the comment starts
              let commentStartIdx = -1;
              for (const marker of commentMarkers) {
                const idx = lineText.indexOf(marker);
                if (idx > 0 && lineText[idx - 1].match(/\s/)) {
                  commentStartIdx = idx - 1; // Include the whitespace before marker
                  break;
                }
              }

              if (commentStartIdx >= 0) {
                const range = new vscode.Range(
                  matchingComment.commentedLineIndex, commentStartIdx,
                  matchingComment.commentedLineIndex, lineText.length
                );
                edit.delete(doc.uri, range);
              }
            }

            await vscode.workspace.applyEdit(edit);
            await doc.save();
          }
        }

        vscode.window.showInformationMessage("VCM: Unmarked Always Show ✅");
        // Update context to refresh menu items
        await updateAlwaysShow(context, deps);
        // Manually update split view if it's open (using splitViewManager)
        await updateSplitViewIfOpen(
          doc,
          provider,
          relativePath,
          getSplitViewState,
          (relativePath) => loadAllVCMComments(relativePath, vcmDir)
        );
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error unmarking comment: " + err.message);
      }
    }
  );
  context.subscriptions.push(unmarkAlwaysShow);

  // ---------------------------------------------------------------------------
  // COMMAND: Right-click -> "Mark as Private"
  // ---------------------------------------------------------------------------
  const markPrivate = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.markPrivate",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Extract current comments and find the one at cursor position
        const docComments = parseDocComs(doc.getText(), doc.uri.path);

        // Find the comment at the selected line
        const commentAtCursor = docComments.find(c => {
          if (c.type === "inline") {
            return c.commentedLineIndex === selectedLine;
          } else if (c.type === "block" && c.block) {
            return c.block.some(b => b.commentedLineIndex === selectedLine);
          }
          return false;
        });

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: You can only mark comment lines as private.");
          return;
        }

        // Build the key using ALL hashes for this comment
        const commentKey = buildContextKey(commentAtCursor);

        // Load or create VCM comments
        let comments = [];
        const { allComments } = await loadAllVCMComments(relativePath, vcmDir);

        if (allComments.length === 0) {
          // No VCM exists - add only this comment to VCM, marked as private
          commentAtCursor.isPrivate = true;
          comments = [commentAtCursor];
        } else {
          // VCM exists - find and mark the matching comment using ALL hashes + text
          comments = allComments;

          // For inline comments, also match on text to distinguish between multiple inline comments with same hashes
          const targetVcmComment = comments.find(vcm => {
            const vcmKey = buildContextKey(vcm);
            if (vcmKey !== commentKey) return false;

            // If this is an inline comment, also match on the text to be more specific
            if (commentAtCursor.type === "inline") {
              return vcm.text === commentAtCursor.text;
            }

            return true;
          });

          if (!targetVcmComment) {
            // Comment not found in existing VCM - add it as a new private comment
            commentAtCursor.isPrivate = true;
            comments.push(commentAtCursor);
          } else {
            targetVcmComment.isPrivate = true;
          }
        }

        // Save updated comments (will split into shared/private automatically)
        await createVCMFiles(relativePath, comments, vcmDir);

        // Check if private comments are currently visible
        const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) === true;

        if (!privateVisible) {
          // Private mode is off, so hide this comment (we already have it in commentAtCursor)
          if (commentAtCursor) {
            const edit = new vscode.WorkspaceEdit();

            if (commentAtCursor.type === "block" && commentAtCursor.block) {
              // Remove the entire block
              const firstLine = commentAtCursor.block[0].commentedLineIndex;
              const lastLine = commentAtCursor.block[commentAtCursor.block.length - 1].commentedLineIndex;
              edit.delete(doc.uri, new vscode.Range(firstLine, 0, lastLine + 1, 0));
            } else if (commentAtCursor.type === "inline") {
              // Remove inline comment from the line
              const currentLine = doc.lineAt(commentAtCursor.commentedLineIndex);
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);
              let commentStartIdx = -1;

              for (const marker of commentMarkers) {
                const idx = currentLine.text.indexOf(marker);
                if (idx > 0 && currentLine.text[idx - 1].match(/\s/)) {
                  commentStartIdx = idx - 1;
                  break;
                }
              }

              if (commentStartIdx >= 0) {
                const newLineText = currentLine.text.substring(0, commentStartIdx).trimEnd();
                edit.replace(doc.uri, currentLine.range, newLineText);
              }
            }

            await vscode.workspace.applyEdit(edit);

            // Mark that we just modified from marking private to prevent re-extraction
            justInjectedFromVCM.add(doc.uri.fsPath);

            await vscode.commands.executeCommand("workbench.action.files.save");
          }

          // Set the global state to false since we auto-hid the comment
          privateCommentsVisible.set(doc.uri.fsPath, false);

          vscode.window.showInformationMessage("VCM: Private comment hidden 🔒 Toggle Private Comments to view.");
        } else {
          vscode.window.showInformationMessage("VCM: Marked as Private 🔒");
        }

        // Update context to refresh menu items
        setTimeout(() => updateAlwaysShow(context, deps), 100);
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error marking comment as Private: " + err.message);
      }
    }
  );
  context.subscriptions.push(markPrivate);

  // ---------------------------------------------------------------------------
  // COMMAND: Right-click -> "Unmark Private"
  // ---------------------------------------------------------------------------
  const unmarkPrivate = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.unmarkPrivate",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Extract current comments and find the one at cursor position
        const docComments = parseDocComs(doc.getText(), doc.uri.path);

        // Find the comment at the selected line
        const currentComment = docComments.find(c => {
          if (c.type === "inline") {
            return c.commentedLineIndex === selectedLine;
          } else if (c.type === "block" && c.block) {
            return c.block.some(b => b.commentedLineIndex === selectedLine);
          }
          return false;
        });

        if (!currentComment) {
          vscode.window.showWarningMessage("VCM: You can only unmark comment lines.");
          return;
        }

        // Load all comments from both shared and private
        const { allComments: comments } = await loadAllVCMComments(relativePath, vcmDir);

        // Build context key for current comment
        const currentKey = buildContextKey(currentComment);

        // Match to VCM comment using context key
        const vcmCandidates = comments.filter(c => c.isPrivate && buildContextKey(c) === currentKey);

        if (vcmCandidates.length === 0) {
          vscode.window.showWarningMessage("VCM: This comment is not marked as private.");
          return;
        }

        // Since we filtered by context key, we should only have exact matches
        // Take the first one (there should typically be only one)
        const targetVcmComment = vcmCandidates[0];

        // Remove isPrivate flag
        delete targetVcmComment.isPrivate;

        // Save updated comments (will split into shared/private automatically)
        await createVCMFiles(relativePath, comments, vcmDir);

        // Check if we need to remove the comment from the document
        const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);
        const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) === true;

        // Remove from document if:
        // 1. In clean mode with private visible (comment is visible but shouldn't be after unmarking)
        // 2. In commented mode with private hidden (comment was visible only because it was private)
        const shouldRemove = (!isInCommentedMode && privateVisible) || (isInCommentedMode && !privateVisible);

        if (shouldRemove) {
          // Remove the comment from the document
          const edit = new vscode.WorkspaceEdit();

          // Use the currentComment we already found
          const matchingComment = currentComment;

          if (matchingComment) {
            if (matchingComment.type === "block" && matchingComment.block) {
              // Remove all lines in the block (from first to last)
              const firstLine = Math.min(...matchingComment.block.map(b => b.commentedLineIndex));
              const lastLine = Math.max(...matchingComment.block.map(b => b.commentedLineIndex));
              const range = new vscode.Range(firstLine, 0, lastLine + 1, 0);
              edit.delete(doc.uri, range);
            } else if (matchingComment.type === "inline") {
              // Remove just the inline comment part (keep the code)
              const lineText = doc.lineAt(matchingComment.commentedLineIndex).text;

              // Find where the comment starts
              let commentStartIndex = -1;
              for (const marker of commentMarkers) {
                const markerRegex = new RegExp(`(\\s+)(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`);
                const match = lineText.match(markerRegex);
                if (match) {
                  commentStartIndex = match.index;
                  break;
                }
              }

              if (commentStartIndex > 0) {
                const range = new vscode.Range(
                  matchingComment.commentedLineIndex,
                  commentStartIndex,
                  matchingComment.commentedLineIndex,
                  lineText.length
                );
                edit.delete(doc.uri, range);
              }
            }

            await vscode.workspace.applyEdit(edit);
            await doc.save();
            // Manually update split view if it's open (using splitViewManager)
            await updateSplitViewIfOpen(
              doc,
              provider,
              relativePath,
              getSplitViewState,
              loadAllVCMComments
            );
          }
        }
        // If in commented mode with private visible, comment stays in document (moved to shared)

        vscode.window.showInformationMessage("VCM: Unmarked Private ✅");
        // Update context to refresh menu items (with small delay to ensure file writes complete)
        setTimeout(async () => {
          await updateAlwaysShow(context, deps);
        }, 100);
      } catch (err) {
        vscode.window.showErrorMessage("VCM: No .vcm file found. Try saving first.");
      }
    }
  );
  context.subscriptions.push(unmarkPrivate);

  // ---------------------------------------------------------------------------
  // COMMAND: Toggle Private Comments Visibility
  // ---------------------------------------------------------------------------
  const togglePrivateComments = vscode.commands.registerCommand(
    "vcm-view-comments-mirror.togglePrivateComments",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      // Disable .vcm sync during toggle to prevent overwriting
      vcmSyncEnabled = false;

      const doc = editor.document;
      const text = doc.getText();
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Load private comments from private VCM file
        const { privateComments } = await loadAllVCMComments(relativePath, vcmDir);

        if (privateComments.length === 0) {
          vscode.window.showInformationMessage("VCM: No private comments found in this file.");
          vcmSyncEnabled = true;
          return;
        }

        // Use stored state as source of truth (updated by undo/redo detection)
        // Toggle flips this state
        const storedState = privateCommentsVisible.get(doc.uri.fsPath);
        const currentlyVisible = storedState !== undefined ? storedState : false;

        let newText;
        if (currentlyVisible) {
          // Hide private comments - remove ONLY private comments using anchor + context hashes
          const privateKeys = new Set(privateComments.map(c =>
            buildContextKey(c)
          ));

          // Extract current comments to identify which ones are private
          const docComments = parseDocComs(text, doc.uri.path);

          // Build a map of private comments by type and anchor for removal
          const privateBlocksToRemove = [];
          const privateInlinesToRemove = [];

          for (const current of docComments) {
            const currentKey = buildContextKey(current);
            if (privateKeys.has(currentKey)) {
              if (current.type === "block") {
                privateBlocksToRemove.push(current);
              } else if (current.type === "inline") {
                privateInlinesToRemove.push(current);
              }
            }
          }

          // Remove private comments from the text
          const lines = text.split("\n");
          const linesToRemove = new Set();

          // Mark block comment lines for removal
          for (const block of privateBlocksToRemove) {
            if (block.block) {
              for (const blockLine of block.block) {
                linesToRemove.add(blockLine.commentedLineIndex);
              }
            }
          }

          // Process lines: filter out block comments and strip inline comments
          const resultLines = [];
          for (let i = 0; i < lines.length; i++) {
            // Skip lines that are part of private block comments
            if (linesToRemove.has(i)) continue;

            let line = lines[i];

            // Check if this line has a private inline comment to remove
            // Match by context (prevHash + nextHash), not by commentedLineIndex which can shift
            const inlineToRemove = privateInlinesToRemove.find(c => {
              // Find the actual line this comment should be on using its anchor
              const codeOnly = line.split(/\s+\/\/|\s+#/).slice(0, 1)[0].trimEnd();
              const lineHash = hashLine(codeOnly, 0);
              
              if (lineHash !== c.anchor) return false;
              
              // Verify context matches
              let prevIdx = -1;
              for (let j = i - 1; j >= 0; j--) {
                if (lines[j].trim()) {
                  prevIdx = j;
                  break;
                }
              }
              let nextIdx = -1;
              for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim()) {
                  nextIdx = j;
                  break;
                }
              }
              
              const actualPrevHash = prevIdx >= 0 ? hashLine(lines[prevIdx], 0) : null;
              const actualNextHash = nextIdx >= 0 ? hashLine(lines[nextIdx], 0) : null;
              
              return actualPrevHash === c.prevHash && actualNextHash === c.nextHash;
            });
            
            if (inlineToRemove) {
              // Remove the inline comment using the same logic as stripComments
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);
              let commentStartIdx = -1;
              for (const marker of commentMarkers) {
                const idx = line.indexOf(marker);
                if (idx > 0 && line[idx - 1].match(/\s/)) {
                  commentStartIdx = idx - 1;
                  break;
                }
              }
              if (commentStartIdx >= 0) {
                line = line.substring(0, commentStartIdx).trimEnd();
              }
            }

            resultLines.push(line);
          }

          newText = resultLines.join("\n");
          privateCommentsVisible.set(doc.uri.fsPath, false);
          vscode.window.showInformationMessage("VCM: Private comments hidden 🔒");
        } else {
          // Show private comments - inject them back
          // Load shared comments too
          const { sharedComments } = await loadAllVCMComments(relativePath, vcmDir);

          // Check current mode to determine what to show
          const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);

          if (isInCommentedMode) {
            // In commented mode: current text already has shared/alwaysShow; just add private
            newText = injectComments(text, privateComments, true);
          } else {
            // In clean mode: current text already has alwaysShow; just add private without toggling mode
            newText = injectComments(text, privateComments, true);
          }

          privateCommentsVisible.set(doc.uri.fsPath, true);

          // Mark that we just injected from VCM so saveVCM doesn't re-extract these as shared comments
          justInjectedFromVCM.add(doc.uri.fsPath);

          vscode.window.showInformationMessage("VCM: Private comments visible 🔓");
        }

        // Replace entire document content
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand("workbench.action.files.save");

        // Manually update split view if it's open (using splitViewManager)
        await updateSplitViewIfOpen(
          doc,
          provider,
          relativePath,
          getSplitViewState,
          (relativePath) => loadAllVCMComments(relativePath, vcmDir)
        );

        // Re-enable sync after a delay to ensure save completes
        setTimeout(() => (vcmSyncEnabled = true), 800);
      } catch (err) {
        vscode.window.showErrorMessage("VCM: Error toggling private comments.");
        vcmSyncEnabled = true;
      }
    }
  );
  context.subscriptions.push(togglePrivateComments);

  // ---------------------------------------------------------------------------
  // COMMAND: Split view with/without comments
  // ---------------------------------------------------------------------------
  // Opens a split view with source on left and clean/commented version on right
  // Currently configured: source (with comments) -> right pane (without comments)
  // TODO: Make this configurable to show comments on right instead
  
  const toggleSplitView = vscode.commands.registerCommand("vcm-view-comments-mirror.toggleSplitViewComments", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;

    // Close any existing VCM split view before opening a new one (only one VCM_ allowed)
    if (tempUri) {
      await closeSplitView(getSplitViewState);
    }

    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const baseName = doc.fileName.split(/[\\/]/).pop();
    const vcmLabel = `VCM_${baseName}`;

    // Load comment data from .vcm file, or extract from current file
    let sharedComments, privateComments;
    try {
      const result = await loadAllVCMComments(relativePath, vcmDir);
      sharedComments = result.sharedComments;
      privateComments = result.privateComments;
    } catch {
      // No .vcm file exists yet - extract and save
      sharedComments = parseDocComs(doc.getText(), doc.uri.path);
      privateComments = [];
      await saveVCM(doc, true); // allowCreate = true for explicit split view action
    }

    // Detect initial state if not already set
    if (!isCommentedMap.has(doc.uri.fsPath)) {
      const initialState = await detectInitialMode(doc, vcmDir);
      isCommentedMap.set(doc.uri.fsPath, initialState);
    }

    // Detect private comment visibility if not already set
    if (!privateCommentsVisible.has(doc.uri.fsPath)) {
      const privateVisible = await detectPrivateVisibility(doc, relativePath);
      privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
    }

    // Create clean version and version with comments
    const text = doc.getText();
    const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;

    // Always include ALL comments (shared + private) in the array
    // Let stripComments and injectComments decide what to do based on keepPrivate flag
    const allComments = [...sharedComments, ...privateComments];
    const clean = stripComments(text, doc.uri.path, allComments, keepPrivate);
    const withComments = injectComments(clean, allComments, keepPrivate);

    // Check the current mode from our state map
    const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);

    // If source is in commented mode, show clean; otherwise, show commented
    const showVersion = isInCommentedMode ? clean : withComments;
    const labelType = isInCommentedMode ? "clean" : "with comments";

    // Insert timestamp before file extension to preserve language detection
    const uniqueLabel = vcmLabel.replace(/(\.[^/.]+)$/, `_${Date.now()}$1`);
    // Create virtual document with vcm-view: scheme
    tempUri = vscode.Uri.parse(`vcm-view:${uniqueLabel}`);
    provider.update(tempUri, showVersion);

    // Open in a proper split pane (like "Open to the Side")
    // Use ViewColumn.Beside to open in a new editor group to the side
    vcmEditor = await vscode.window.showTextDocument(tempUri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,  // Don't use preview mode so it persists as a tab
      preserveFocus: true  // Keep focus on source editor
    });

    // Track which source document has the split view open for live sync
    sourceDocUri = doc.uri;

    // Dispose of any existing scroll listener before creating a new one
    if (scrollListener) {
      scrollListener.dispose();
      scrollListener = null;
    }

    // Setup bidirectional click-to-jump (source ↔ split view)
    const sourceEditor = editor;

    let activeHighlight;
    let reverseActiveHighlight;

    scrollListener = vscode.window.onDidChangeTextEditorSelection(async e => {
      if (!vcmEditor) return;

      // Only jump on mouse clicks, not keyboard navigation or typing
      // e.kind will be undefined for typing, 1 for keyboard, 2 for mouse
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;

      // Direction 1: Source → Split View
      if (e.textEditor === sourceEditor) {
        const cursorPos = e.selections[0].active;
        const wordRange = sourceEditor.document.getWordRangeAtPosition(cursorPos);
        if (!wordRange) return;

        const word = sourceEditor.document.getText(wordRange);
        if (!word || word.length < 2) return;

        // Extract line context to improve matching accuracy
        const sourceLine = sourceEditor.document.lineAt(cursorPos.line).text.trim();
        const targetText = vcmEditor.document.getText();
        const targetLines = targetText.split("\n");

        // Try to find the same line context first (exact match or partial)
        let targetLine = targetLines.findIndex(line => line.trim() === sourceLine.trim());
        if (targetLine === -1) {
          // fallback: find first line containing the word as whole word
          const wordRegex = new RegExp(`\\b${word}\\b`);
          targetLine = targetLines.findIndex(line => wordRegex.test(line));
        }

        if (targetLine === -1) return;

        // Jump + highlight that line
        const targetPos = new vscode.Position(targetLine, 0);
        vcmEditor.selection = new vscode.Selection(targetPos, targetPos);
        vcmEditor.revealRange(
          new vscode.Range(targetPos, targetPos),
          vscode.TextEditorRevealType.InCenter
        );

        // Remove previous highlight if exists
        if (activeHighlight) {
          activeHighlight.dispose();
          activeHighlight = null;
        }

        // Create a highlight using the editor's built-in selection color
        activeHighlight = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
          isWholeLine: true,
        });

        vcmEditor.setDecorations(activeHighlight, [
          new vscode.Range(targetPos, targetPos),
        ]);
      }

      // Direction 2: Split View → Source
      else if (e.textEditor === vcmEditor) {
        const cursorPos = e.selections[0].active;
        const wordRange = vcmEditor.document.getWordRangeAtPosition(cursorPos);
        if (!wordRange) return;

        const word = vcmEditor.document.getText(wordRange);
        if (!word || word.length < 2) return;

        // Extract line context to improve matching accuracy
        const splitLine = vcmEditor.document.lineAt(cursorPos.line).text.trim();
        const sourceText = sourceEditor.document.getText();
        const sourceLines = sourceText.split("\n");

        // Try to find the same line context first (exact match or partial)
        let sourceLine = sourceLines.findIndex(line => line.trim() === splitLine.trim());
        if (sourceLine === -1) {
          // fallback: find first line containing the word as whole word
          const wordRegex = new RegExp(`\\b${word}\\b`);
          sourceLine = sourceLines.findIndex(line => wordRegex.test(line));
        }

        if (sourceLine === -1) return;

        // Jump + highlight that line
        const sourcePos = new vscode.Position(sourceLine, 0);
        sourceEditor.selection = new vscode.Selection(sourcePos, sourcePos);
        sourceEditor.revealRange(
          new vscode.Range(sourcePos, sourcePos),
          vscode.TextEditorRevealType.InCenter
        );

        // Remove previous highlight if exists
        if (reverseActiveHighlight) {
          reverseActiveHighlight.dispose();
          reverseActiveHighlight = null;
        }

        // Create a highlight using the editor's built-in selection color
        reverseActiveHighlight = vscode.window.createTextEditorDecorationType({
          backgroundColor: new vscode.ThemeColor("editor.selectionBackground"),
          isWholeLine: true,
        });

        sourceEditor.setDecorations(reverseActiveHighlight, [
          new vscode.Range(sourcePos, sourcePos),
        ]);
      }
    });
    context.subscriptions.push(scrollListener);

    // Decorate the banner
    const banner = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        contentText: `💬 ${vcmLabel} (${labelType})`,
        color: "#00ff88",
        fontWeight: "bold",
        backgroundColor: "#00330088",
        margin: "0 1rem 0 0",
      },
    });
    vcmEditor.setDecorations(banner, [new vscode.Range(0, 0, 0, 0)]);
  });
  context.subscriptions.push(toggleSplitView);
}

// Extension deactivation - cleanup resources
function deactivate() {
  if (scrollListener) scrollListener.dispose();
  if (vcmEditor) vscode.commands.executeCommand("workbench.action.closeEditorsInGroup");
}

module.exports = { activate, deactivate };
