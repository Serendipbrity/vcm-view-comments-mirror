// ==============================================================================
// VCM (Visual Comment Manager) Extension for VS Code
// ==============================================================================
// This extension provides multiple modes for managing comments in source code:
// 1. Split view: Source on left, clean/commented version on right
// 2. Single file toggle: Hide/show comments in the same file
// 3. Persistent storage: Comments saved to .vcm directory for reconstruction
// ==============================================================================

const vscode = require("vscode"); // vs code api module. lets us talk to and control VSCode itself
const { getCommentMarkersForFile } = require("./src/utils_copycode/commentMarkers");
const { VCMContentProvider } = require("./src/split_view/contentProvider");
const { hashLine } = require("./src/utils_copycode/hash");
const { injectComments, stripComments } = require("./src/helpers_subroutines/injectExtractComments");
const { parseDocComs, addPrimaryAnchors } = require("./src/vcm/utils_copycode/parseDocComs");
const { mergeIntoVCMs } = require("./src/vcm/helpers_subroutines/mergeIntoVCMs");
const { createDetectors } = require("./src/helpers_subroutines/detectModes");
const { buildContextKey } = require("./src/utils_copycode/buildContextKey");
const { setupSplitViewWatchers, updateSplitViewIfOpen, closeSplitView } = require("./src/split_view/splitViewManager");
const { vcmFileExists } = require("./src/vcm/utils_copycode/vcmFileExists");
const { readBothVCMs, readSharedVCM, readPrivateVCM } = require("./src/vcm/utils_copycode/readBothVCMs");
const { writeSharedVCM, writePrivateVCM } = require("./src/vcm/helpers_subroutines/createVCMFiles");
const { findInlineCommentStart, isolateCodeLine } = require("./src/utils_copycode/lineUtils");
const { updateAlwaysShow } = require("./src/helpers_subroutines/alwaysShow");
const { mergeSharedTextCleanMode } = require("./src/utils_copycode/mergeTextCleanMode");
const { findCommentAtCursor } = require("./src/utils_copycode/findCommentAtCursor");
const { getCommentText } = require("./src/utils_copycode/getCommentText");
const { isSameComment } = require("./src/utils_copycode/isSameComment");
const { injectMissingPrivateComments } = require("./src/helpers_subroutines/injectMissingPrivateComments");
const { isAlwaysShow } = require("./src/helpers_subroutines/alwaysShow");
const { generateCommentedVersion } = require("./src/helpers_subroutines/generateCommentedVersion");
const { commentedModeBehavior } = require("./src/helpers_subroutines/commentedModeBehavior");
const { cleanModeBehavior } = require("./src/helpers_subroutines/cleanModeBehavior");

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
let justInjectedFromPrivateVCM = new Set(); // Track files that just had private VCM comments injected/stripped (don't re-extract)
let privateCommentsVisible = new Map(); // Track private comment visibility per file: true = visible, false = hidden


// -----------------------------------------------------------------------------
// Extension Activate
// -----------------------------------------------------------------------------

// Capture a fresh timestamp for each activation so logs show when the extension loaded
const buildTag = (() => {
  const iso = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  return iso.replace("T", "-");
})();
// Cache: per document URI string -> { version, index }
// Cache: per document URI string -> { version, index }
const _commentJumpIndexCache = new Map();

/**
 * Build jump indexes from already-parsed comments.
 * parseDocComs is the single source of truth for comment parsing.
 *
 * Returns:
 * - lineToComment: Map<lineNumber, commentObject> - O(1) click detection
 * - keyToLines: Map<contextKey, number[]> - where each comment exists by full context
 * - anchorToLines: Map<anchorHash, number[]> - where each anchor exists (fallback for clean mode)
 */
function buildCommentJumpIndex(parsedComments, docText, sourceFilePathForMarkers) {
  const lineToComment = new Map();
  const keyToLines = new Map();
  const anchorToLines = new Map();

  // -------------------------
  // 1) Index comments by line and context key
  // -------------------------
  for (const c of parsedComments) {
    const key = buildContextKey(c);

    // Track which doc lines are "inside a comment" for O(1) click detection
    if (c.type === "inline" || c.type === "line") {
      lineToComment.set(c.commentedLineIndex, c);
    } else if (c.type === "block" && Array.isArray(c.block)) {
      for (const b of c.block) {
        lineToComment.set(b.commentedLineIndex, c);
      }
    }

    // Track where this comment exists by its full context key
    const firstLine =
      c.type === "inline" || c.type === "line"
        ? c.commentedLineIndex
        : Array.isArray(c.block) && c.block.length > 0
        ? c.block[0].commentedLineIndex
        : null;

    if (typeof firstLine === "number") {
      if (!keyToLines.has(key)) keyToLines.set(key, []);
      keyToLines.get(key).push(firstLine);
    }
  }

  // -------------------------
  // 2) Index anchors by scanning the document with parseDocComs logic
  //    This is needed for fallback when clicking comments in a file
  //    and jumping to clean mode where comments don't exist
  // -------------------------
  const lines = docText.split("\n");
  const commentMarkers = getCommentMarkersForFile(sourceFilePathForMarkers);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;

    const commentStart = findInlineCommentStart(raw, commentMarkers, { requireWhitespaceBefore: true });

    if (commentStart >= 0) {
      // This line has an inline comment - hash the code portion only
      const codeOnly = raw.substring(0, commentStart).trimEnd();
      if (codeOnly) {
        const codeHash = hashLine(codeOnly, 0);
        if (!anchorToLines.has(codeHash)) anchorToLines.set(codeHash, []);
        anchorToLines.get(codeHash).push(i);
      }
    } else {
      // No inline comment - hash the full line (for block comment anchors)
      const fullHash = hashLine(raw.trimEnd(), 0);
      if (!anchorToLines.has(fullHash)) anchorToLines.set(fullHash, []);
      anchorToLines.get(fullHash).push(i);
    }
  }

  return { lineToComment, keyToLines, anchorToLines };
}

function getCommentJumpIndexForDoc(doc, sourceFilePathForMarkers) {
  const cacheKey = doc.uri.toString();
  const cached = _commentJumpIndexCache.get(cacheKey);

  // Same doc version = same text snapshot in VS Code -> safe cache hit
  if (cached && cached.version === doc.version) {
    return cached.index;
  }

  const text = doc.getText();
  const parsed = parseDocComs(text, sourceFilePathForMarkers);
  const index = buildCommentJumpIndex(parsed, text, sourceFilePathForMarkers);

  _commentJumpIndexCache.set(cacheKey, { version: doc.version, index });
  return index;
}


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
  const liveSync = config.get("liveSync", true);       // Auto-save .vcm on edit

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
  
  const deps = { readBothVCMs: (relativePath) => readBothVCMs(relativePath, vcmDir, vcmPrivateDir), // shared + private
  parseDocComs,
  };

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
    readSharedVCM: (relativePath) => readSharedVCM(relativePath, vcmDir),
    vcmDir,
    readPrivateVCM: (relativePath) => readPrivateVCM(relativePath, vcmPrivateDir),
    vcmPrivateDir,
    parseDocComs,
    vscode,
    vcmFileExists,
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

    // Check if we just injected/stripped private comments from VCM
    // (this flag prevents re-extracting immediately after private toggle)
    const wasJustInjectedPrivate = justInjectedFromPrivateVCM.has(doc.uri.fsPath);
    if (wasJustInjectedPrivate) {
      justInjectedFromPrivateVCM.delete(doc.uri.fsPath);
    }

    const text = doc.getText();

    // ✅ READ SHARED + PRIVATE (shared save needs private only to exclude)
    const sharedVCMComments = await readSharedVCM(relativePath, vcmDir);
    const privateVCMComments = await readPrivateVCM(relativePath, vcmPrivateDir);

    // Get the current mode from our state map
    // IMPORTANT: Once mode is set, it should NEVER change except via manual toggle or undo/redo
    let isCommented = isCommentedMap.get(doc.uri.fsPath);
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

    let parseText = text;

    const docComments = parseDocComs(parseText, doc.uri.path);

    // Build a set of private/alwaysShow keys for consecutive-group primary anchors
    // CRITICAL: In commented mode, keys can change when code moves (prevHash/nextHash changes)
    // So we also build a text-based map for fallback matching
    // Use primary fields when available for consecutive comment matching
    const privateKeys = new Set(privateVCMComments.map(c => {
      const hasPrimary = c.primaryAnchor !== undefined || c.primaryPrevHash !== undefined || c.primaryNextHash !== undefined;
      return buildContextKey(c, { usePrimaryAnchor: hasPrimary });
    }));
    const alwaysShowComments = sharedVCMComments.filter(c => isAlwaysShow(c));
    const alwaysShowKeys = new Set(alwaysShowComments.map(c => {
      const hasPrimary = c.primaryAnchor !== undefined || c.primaryPrevHash !== undefined || c.primaryNextHash !== undefined;
      return buildContextKey(c, { usePrimaryAnchor: hasPrimary });
    }));
    const privateTextMap = new Map();
    for (const c of privateVCMComments) {
      const textKey = getCommentText(c);
      if (textKey) privateTextMap.set(textKey, c);
    }

    const privateTextSet = new Set(privateTextMap.keys());
    addPrimaryAnchors(docComments, { lines: parseText.split("\n") });

    // ----------------------------
    // A) SHARED PIPELINE
    // ----------------------------
    // Filter out private comments from docComments for shared processing
    // Private comments should NEVER be in shared VCM
    // Match by BOTH context key AND text content (handles code movement)
    const sharedDocComments = docComments.filter(c => {
      // Check context key first - use primary fields when available
      const hasPrimary = c.primaryAnchor !== undefined || c.primaryPrevHash !== undefined || c.primaryNextHash !== undefined;
      if (privateKeys.has(buildContextKey(c, { usePrimaryAnchor: hasPrimary }))) return false;

      // Also check by text content (in case code moved and key changed)
      const currentText = getCommentText(c);
      if (currentText && privateTextMap.has(currentText)) return false;

      return true; // Not private, include in shared
    });

    let finalShared = mergeIntoVCMs({
      isCommented,
      docComments: sharedDocComments,
      vcmComments: sharedVCMComments,
      isPrivateMode: false,
      wasJustInjected,
      allowSpacingUpdate: isCommented === true,
    });

    // Keep your empty-comment filter if you want (shared only)
    finalShared = finalShared.filter(comment => {
      if (comment.type === "inline") {
        return (comment.text && comment.text.trim()) ||
              (comment.text_cleanMode && comment.text_cleanMode.trim());
      } else if (comment.type === "line") {
        if (comment.text !== undefined) return true;
        if (comment.text_cleanMode !== undefined) return true;
        return false;
      } else if (comment.type === "block") {
        const hasBlock = comment.block && Array.isArray(comment.block) && comment.block.length > 0;
        const hasTextCleanMode = comment.text_cleanMode && Array.isArray(comment.text_cleanMode) && comment.text_cleanMode.length > 0;
        return hasBlock || hasTextCleanMode;
      }
      return true;
    });

    // CRITICAL: Final safety filter - ensure NO private comments end up in shared VCM
    finalShared = finalShared.filter(comment => !comment.isPrivate);

    // ✅ WRITE SHARED ONLY
    console.log("[saveVCM] About to write shared VCM, finalShared count:", finalShared.length);
    await writeSharedVCM(relativePath, finalShared, vcmDir);
    console.log("[saveVCM] Wrote shared VCM successfully");

    // ----------------------------
    // B) PRIVATE PIPELINE
    // Only run this if private exists or private is visible.
    // ----------------------------
    const privateVisibleNow = privateCommentsVisible.get(doc.uri.fsPath) === true;

    if (!privateVisibleNow && privateVCMComments.length > 0) {
      // Build key sets using primary fields when available (for consecutive comment matching)
      const privatePrimaryKeysForVirtual = new Set();
      const privateTextSetForVirtual = new Set();
      for (const c of privateVCMComments) {
        const hasPrimary = c.primaryAnchor !== undefined || c.primaryPrevHash !== undefined || c.primaryNextHash !== undefined;
        if (hasPrimary) {
          privatePrimaryKeysForVirtual.add(buildContextKey(c, { usePrimaryAnchor: true }));
        }
        const textKey = getCommentText(c);
        if (textKey) privateTextSetForVirtual.add(textKey);
      }
      const virtualBaseText = isCommented
        ? text
        : injectComments(text, doc.uri.path, sharedVCMComments, true, false);
      const virtualPrivateText = injectComments(virtualBaseText, doc.uri.path, privateVCMComments, true, true);
      const virtualPrivateDoc = parseDocComs(virtualPrivateText, doc.uri.path);
      addPrimaryAnchors(virtualPrivateDoc, { lines: virtualPrivateText.split("\n") });
      console.log("[DEBUG virtualPrivateDoc] after addPrimaryAnchors:", virtualPrivateDoc.map(c => ({
        text: getCommentText(c)?.substring(0, 30),
        primaryAnchor: c.primaryAnchor,
        primaryAnchorText: c.primaryAnchorText?.substring(0, 30),
        primaryPrevHash: c.primaryPrevHash,
        primaryPrevHashText: c.primaryPrevHashText?.substring(0, 30),
      })));
      const virtualPrivateMatched = virtualPrivateDoc.filter(dc => {
        // Only match by primary keys when available; avoid base-key collisions with shared comments.
        const hasPrimary = dc.primaryAnchor !== undefined || dc.primaryPrevHash !== undefined || dc.primaryNextHash !== undefined;
        if (hasPrimary) {
          const key = buildContextKey(dc, { usePrimaryAnchor: true });
          if (privatePrimaryKeysForVirtual.has(key)) return true;
        }
        const textKey = getCommentText(dc);
        return textKey && privateTextSetForVirtual.has(textKey);
      });
      console.log("[DEBUG virtualPrivateMatched] filtered:", virtualPrivateMatched.map(c => ({
        text: getCommentText(c)?.substring(0, 30),
        primaryAnchor: c.primaryAnchor,
        primaryAnchorText: c.primaryAnchorText?.substring(0, 30),
      })));
      const refreshedPrivate = mergeIntoVCMs({
        isCommented: true,
        docComments: virtualPrivateMatched,
        vcmComments: privateVCMComments,
        isPrivateMode: true,
        wasJustInjected: true,
        allowSpacingUpdate: false,
      });
      await writePrivateVCM(relativePath, refreshedPrivate, vcmPrivateDir);
    } else if (privateVisibleNow) {
      // Filter to only private comments from docComments for private processing
      // Match by BOTH context key AND text content (handles code movement)
      const privateTextSet = new Set(
        privateVCMComments.map(c => getCommentText(c)).filter(Boolean)
      );
      const privateDocComments = docComments.filter(c => {
        const hasPrimary = c.primaryAnchor !== undefined || c.primaryPrevHash !== undefined || c.primaryNextHash !== undefined;
        if (privateKeys.has(buildContextKey(c, { usePrimaryAnchor: hasPrimary }))) return true;
        if (privateVCMComments.some(p => isSameComment(p, c))) return true;
        const textKey = getCommentText(c);
        return textKey && privateTextSet.has(textKey);
      });

      let finalPrivate = mergeIntoVCMs({
        isCommented: privateVisibleNow,
        docComments: privateDocComments,
        vcmComments: privateVCMComments,
        isPrivateMode: true,
        wasJustInjected: wasJustInjectedPrivate,
        allowSpacingUpdate: privateVisibleNow === true,
      });

      // CRITICAL: DO NOT filter out empty private comments
      // Private comments persist until explicitly unmarked, even if content is deleted
      // Only verify that isPrivate flag is set
      finalPrivate = finalPrivate.filter(comment => comment.isPrivate === true);

      // ✅ WRITE PRIVATE ONLY
      await writePrivateVCM(relativePath, finalPrivate, vcmPrivateDir);
    }
  }

  const saveWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
    if (!vcmSyncEnabled) return;  // Skip if we're in the middle of a toggle
    // allowCreate = false (default): only update existing VCM files, don't create new ones
    await saveVCM(doc);
  });
  context.subscriptions.push(saveWatcher);

  const undoRedoWatcher = vscode.workspace.onDidChangeTextDocument(async (e) => {
    if (!e || !e.document) return;
    if (e.document.uri.scheme !== "file") return;
    if (e.document.uri.path.includes("/.vcm/")) return;
    if (e.document.languageId === "json") return;
    if (e.reason !== vscode.TextDocumentChangeReason.Undo && e.reason !== vscode.TextDocumentChangeReason.Redo) {
      return;
    }

    try {
      const doc = e.document;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);
      const storedMode = isCommentedMap.get(doc.uri.fsPath);
      const detectedMode = await detectInitialMode(doc, { storedMode });
      isCommentedMap.set(doc.uri.fsPath, detectedMode);
      const privateVisible = await detectPrivateVisibility(doc, relativePath);
      privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
    } catch (err) {
      console.warn("VCM: Undo/redo mode refresh failed", err);
    }
  });
  context.subscriptions.push(undoRedoWatcher);

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
    vcmPrivateDir,
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
    (relativePath) => readSharedVCM(relativePath, vcmDir),
    (relativePath) => readPrivateVCM(relativePath, vcmPrivateDir),
    detectInitialMode,
    detectPrivateVisibility,
    _commentJumpIndexCache
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
      // Single VCM creation path: Use saveVCM(doc, true) to create/update
      await saveVCM(doc, true); // Single canonical creation/update path

      // Load shared comments for stripping
      const sharedComments = await readSharedVCM(relativePath, vcmDir);

      const privateComments = await readPrivateVCM(relativePath, vcmPrivateDir);
      const sharedContext = [...sharedComments, ...privateComments];
      // Strip shared comments (stripComments automatically preserves alwaysShow)
      newText = stripComments(text, doc.uri.path, sharedComments, { contextComments: sharedContext });

      const privateWasVisible = privateCommentsVisible.get(doc.uri.fsPath) === true;
      if (privateWasVisible) {
        const privateContext = [...sharedComments, ...privateComments];
        newText = stripComments(newText, doc.uri.path, privateComments, { contextComments: privateContext });
        justInjectedFromPrivateVCM.add(doc.uri.fsPath);
      }

      // Mark this file as now in clean mode
      isCommentedMap.set(doc.uri.fsPath, false);
      // private comments not allowed in clean mode - mark as hidden
      privateCommentsVisible.set(doc.uri.fsPath, false);
      vscode.window.showInformationMessage("VCM: Switched to clean mode (comments hidden)");
    } else {
      // Currently in clean mode -> switch to commented mode (show comments)
      try {
        newText = await generateCommentedVersion(text, doc.uri.path, relativePath, readSharedVCM, vcmDir);

        const existingSharedComments = await readSharedVCM(relativePath, vcmDir);
        const mergedSharedComments = mergeSharedTextCleanMode(existingSharedComments);
        await writeSharedVCM(relativePath, mergedSharedComments, vcmDir);

        // Mark this file as now in commented mode
        isCommentedMap.set(doc.uri.fsPath, true);
        // DO NOT change privateCommentsVisible - private comment visibility persists across mode toggles

        // Mark that we just injected from VCM - don't re-extract on next save
        justInjectedFromVCM.add(doc.uri.fsPath);

        vscode.window.showInformationMessage("VCM: Switched to commented mode (comments visible)");
      } catch {
        isCommentedMap.set(doc.uri.fsPath, true);
        await saveVCM(doc, true);
        try {
          const sharedComments = await readSharedVCM(relativePath, vcmDir);

          // Strip any comments typed in clean mode
          const cleanText = stripComments(text, doc.uri.path, sharedComments);

          // Inject shared comments
          newText = injectComments(cleanText, doc.uri.path, sharedComments, true, false);

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

    if (isCommentedMap.get(doc.uri.fsPath) === true) {
      await saveVCM(doc, true);
    }

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
        const docText = doc.getText();
        const docComments = parseDocComs(docText, doc.uri.path);

        // Find the comment at the selected line
        const commentAtCursor = findCommentAtCursor(docComments, selectedLine);

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: You can only mark comment lines as 'Always Show'.");
          return;
        }

        // Ensure VCM exists before modifying metadata
        const sharedVCMExists = await vcmFileExists(vcmDir, relativePath);

        // If no shared VCM exists - create it first via saveVCM
        if (!sharedVCMExists) {
          await saveVCM(doc, true); // Single creation path
          // Re-read after creation
          comments = await readSharedVCM(relativePath, vcmDir);
        } else {
          // VCM exists - read comments
          comments = await readSharedVCM(relativePath, vcmDir);
        }

        // Find and mark the comment - alwaysShow is always in doc so isSameComment works
        const targetVcmComment = comments.find(c => isSameComment(c, commentAtCursor));
        if (targetVcmComment) {
          targetVcmComment.alwaysShow = true;
        } else {
          // Comment not found in existing VCM - add it as a new entry with alwaysShow
          commentAtCursor.alwaysShow = true;
          comments.push(commentAtCursor);
        }

        await writeSharedVCM(relativePath, comments, vcmDir);
        // await createVCMFiles(relativePath, comments, vcmDir);

        vscode.window.showInformationMessage("VCM: Marked as Always Show ✅");
        // Update context to refresh menu items
        await updateAlwaysShow(context, deps);
        // Manually update split view if it's open (using splitViewManager)
        await updateSplitViewIfOpen(
          doc,
          provider,
          relativePath,
          getSplitViewState,
          (relativePath) => readSharedVCM(relativePath, vcmDir),
          (relativePath) => readPrivateVCM(relativePath, vcmPrivateDir)
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
        const docText = doc.getText();
        const docComments = parseDocComs(docText, doc.uri.path);

        // Find the comment at the selected line
        const commentAtCursor = findCommentAtCursor(docComments, selectedLine);

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: You can only unmark comment lines.");
          return;
        }

        const sharedVCMExists = await vcmFileExists(vcmDir, relativePath);

        if (!sharedVCMExists) {
          vscode.window.showWarningMessage("VCM: No .vcm file found.");
          return;
        }

        const allComments = await readSharedVCM(relativePath, vcmDir);

        // Search for comment and remove alwaysShow - alwaysShow is always in doc so isSameComment works
        let found = false;
        for (const c of allComments) {
          if (isSameComment(c, commentAtCursor) && isAlwaysShow(c)) {
            delete c.alwaysShow;
            found = true;
            break;
          }
        }

        if (!found) {
          vscode.window.showWarningMessage("VCM: This comment is not marked as Always Show.");
          return;
        }

        await writeSharedVCM(relativePath, allComments, vcmDir);
        // await createVCMFiles(relativePath, comments, vcmDir);

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
            } else if (matchingComment.type === "line") {
              // Remove the standalone line comment
              const range = new vscode.Range(matchingComment.commentedLineIndex, 0, matchingComment.commentedLineIndex + 1, 0);
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
          (relativePath) => readSharedVCM(relativePath, vcmDir),
          (relativePath) => readPrivateVCM(relativePath, vcmPrivateDir)
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

      // Prevent saveVCM watcher loops while we mutate the doc + write VCMs
      vcmSyncEnabled = false;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Extract current comments and find the one at cursor position
        const docText = doc.getText();
        const docLines = docText.split("\n");
        const docComments = parseDocComs(docText, doc.uri.path);

        // Load current VCM state
        const sharedExists = await vcmFileExists(vcmDir, relativePath);
        const privateExists = await vcmFileExists(vcmPrivateDir, relativePath);

        // Load current private VCM to build privateKeys for enrichment
        addPrimaryAnchors(docComments, { lines: docLines });

        // Find the comment at the selected line
        const commentAtCursor = findCommentAtCursor(docComments, selectedLine);

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: You can only mark comment lines as private.");
          return;
        }
        if (commentAtCursor.type === "inline") {
          vscode.window.showWarningMessage("VCM: Inline comments can't be marked as private.");
          return;
        }

        commentAtCursor.isPrivate = true;

        // If no VCM exists at all, create it first via saveVCM (single creation path)
        let sharedComments, privateComments;
        if (!sharedExists && !privateExists) {
          await saveVCM(doc, true);
          // Re-read after creation
          sharedComments = await readSharedVCM(relativePath, vcmDir);
          privateComments = [];
        } else {
          // Read lists (if file doesn't exist, treat as empty)
          sharedComments = sharedExists ? await readSharedVCM(relativePath, vcmDir) : [];
          privateComments = privateExists ? await readPrivateVCM(relativePath, vcmPrivateDir) : [];
        }

        // 1) REMOVE from shared (we are moving it out)
        //    Only remove comments that match this exact one (key + text/block when possible)
        sharedComments = sharedComments.filter((c) => !isSameComment(c, commentAtCursor));

        // 2) ADD to private (if not already there)
        //    Note: private VCM file should NOT store isPrivate (your writer strips it)
        const alreadyInPrivate = privateComments.some((c) => isSameComment(c, commentAtCursor));
        if (!alreadyInPrivate) {
          // mark for in-memory handling (writers may strip it, but your flow expects it sometimes)
          privateComments.push(commentAtCursor);
        }

        // 3) Write both VCMs back
        //    - shared gets the filtered list
        //    - private gets the added list (and will create the file if needed)
        await writePrivateVCM(relativePath, privateComments, vcmPrivateDir);
        await writeSharedVCM(relativePath, sharedComments, vcmDir);
        // Manually update split view if it's open (using splitViewManager)
        await updateSplitViewIfOpen(
          doc,
          provider,
          relativePath,
          getSplitViewState,
          (relativePath) => readSharedVCM(relativePath, vcmDir),
          (relativePath) => readPrivateVCM(relativePath, vcmPrivateDir)
        );

        // Decide whether to hide it in the editor based on the toggle state
        const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) === true;

        if (!privateVisible) {
          // Private is OFF, so hide the comment text in the document immediately
          const edit = new vscode.WorkspaceEdit();

          if (commentAtCursor.type === "block" && commentAtCursor.block) {
            // Remove the entire block
            const firstLine = commentAtCursor.block[0].commentedLineIndex;
            const lastLine = commentAtCursor.block[commentAtCursor.block.length - 1].commentedLineIndex;

            // Delete whole lines including newline by targeting (lastLine + 1, 0)
            edit.delete(doc.uri, new vscode.Range(firstLine, 0, lastLine + 1, 0));
          } else if (commentAtCursor.type === "line") {
            // Remove the standalone line comment
            edit.delete(doc.uri, new vscode.Range(commentAtCursor.commentedLineIndex, 0, commentAtCursor.commentedLineIndex + 1, 0));
          } else if (commentAtCursor.type === "inline") {
            // Remove inline comment portion from that single line
            const currentLine = doc.lineAt(commentAtCursor.commentedLineIndex);
            const commentMarkers = getCommentMarkersForFile(doc.uri.path);

            let commentStartIdx = -1;

            // Find marker start position that indicates an inline comment (marker preceded by whitespace)
            for (const marker of commentMarkers) {
              const idx = currentLine.text.indexOf(marker);
              if (idx > 0 && /\s/.test(currentLine.text[idx - 1])) {
                commentStartIdx = idx - 1; // include the whitespace before marker
                break;
              }
            }

            if (commentStartIdx >= 0) {
              // Keep only code portion
              const newLineText = currentLine.text.substring(0, commentStartIdx).trimEnd();
              edit.replace(doc.uri, currentLine.range, newLineText);
            }
          }

          // Apply doc edit
          await vscode.workspace.applyEdit(edit);

          // Prevent immediate re-extraction/double-processing
          justInjectedFromVCM.add(doc.uri.fsPath);

          // Save the file (this is what makes your behavior consistent with shared live sync)
          await vscode.commands.executeCommand("workbench.action.files.save");

          // Ensure toggle state remains OFF (we just hid something)
          privateCommentsVisible.set(doc.uri.fsPath, false);

          vscode.window.showInformationMessage("VCM: Private comment hidden 🔒 Toggle Private Comments to view.");
        } else {
          vscode.window.showInformationMessage("VCM: Marked as Private 🔒");
        }

        // Refresh context/UI
        setTimeout(() => updateAlwaysShow(context, deps), 100);
      } catch (err) {
        vscode.window.showErrorMessage(
          "VCM: Error marking comment as Private: " + (err?.message || String(err))
        );
      } finally {
        // Re-enable sync after a short delay to avoid watcher racing our edits
        setTimeout(() => (vcmSyncEnabled = true), 800);
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
      vcmSyncEnabled = false;

      const doc = editor.document;
      const selectedLine = editor.selection.active.line;
      const relativePath = vscode.workspace.asRelativePath(doc.uri);

      try {
        // Extract current comments and find the one at cursor position
        const docComments = parseDocComs(doc.getText(), doc.uri.path);
        // const docText = doc.getText();
        // const docLines = docText.split("\n");
        // Load VCM state (treat missing files as empty)
        const sharedExists = await vcmFileExists(vcmDir, relativePath);
        const privateExists = await vcmFileExists(vcmPrivateDir, relativePath);

        // addPrimaryAnchors(docComments, { lines: docLines });

        // Find the comment at the selected line
        const commentAtCursor = findCommentAtCursor(docComments, selectedLine);

        if (!commentAtCursor) {
          vscode.window.showWarningMessage("VCM: You can only unmark comment lines.");
          return;
        }

        // If no VCM exists at all, create it first via saveVCM (single creation path)
        let sharedComments, privateComments;
        if (!sharedExists && !privateExists) {
          await saveVCM(doc, true);
          // Re-read after creation
          sharedComments = await readSharedVCM(relativePath, vcmDir);
          privateComments = [];
        } else {
          sharedComments = sharedExists ? await readSharedVCM(relativePath, vcmDir) : [];
          privateComments = privateExists ? await readPrivateVCM(relativePath, vcmPrivateDir) : [];
        }

        // 1) Ensure it exists in private (otherwise it's not private)
        const existsInPrivate = privateComments.some((c) => isSameComment(c, commentAtCursor));
        if (!existsInPrivate) {
          vscode.window.showWarningMessage("VCM: This comment is not marked as private.");
          return;
        }

        // 2) Remove from private
        privateComments = privateComments.filter((c) => !isSameComment(c, commentAtCursor));

        // 3) Add to shared (if not already there)
        const existsInShared = sharedComments.some((c) => isSameComment(c, commentAtCursor));
        if (!existsInShared) {
          // Ensure we don't carry isPrivate into shared storage
          const { isPrivate, ...rest } = commentAtCursor;
          sharedComments.push(rest);
        }

        // 4) Write both
        await writeSharedVCM(relativePath, sharedComments, vcmDir);
        await writePrivateVCM(relativePath, privateComments, vcmPrivateDir);

        // --- Doc visibility logic ---
        let isInCommentedMode = isCommentedMap.get(doc.uri.fsPath) === true;
        if (!isInCommentedMode) {
          const hasDocComments = parseDocComs(docText, doc.uri.path).length > 0;
          if (hasDocComments) {
            isCommentedMap.set(doc.uri.fsPath, true);
            isInCommentedMode = true;
          }
        }

        // After unmarking:
        // - If shared comments are visible in the current mode, DO NOT delete from doc.
        // - If shared comments are not visible in the current mode, then we should remove it from doc.
        //
        // In your extension:
        // - Clean mode = shared hidden, commented mode = shared visible.
        // So: remove only if we're in clean mode.
        const shouldRemoveFromDoc = !isInCommentedMode;

        if (shouldRemoveFromDoc) {
          // Remove the comment from the document
          const edit = new vscode.WorkspaceEdit();

          if (commentAtCursor.type === "block" && commentAtCursor.block) {
            const firstLine = Math.min(...commentAtCursor.block.map((b) => b.commentedLineIndex));
            const lastLine = Math.max(...commentAtCursor.block.map((b) => b.commentedLineIndex));
            edit.delete(doc.uri, new vscode.Range(firstLine, 0, lastLine + 1, 0));
          } else if (commentAtCursor.type === "line") {
            edit.delete(doc.uri, new vscode.Range(commentAtCursor.commentedLineIndex, 0, commentAtCursor.commentedLineIndex + 1, 0));
          } else if (commentAtCursor.type === "inline") {
            const currentLine = doc.lineAt(commentAtCursor.commentedLineIndex);
            const commentMarkers = getCommentMarkersForFile(doc.uri.path);

            let commentStartIdx = -1;

            for (const marker of commentMarkers) {
              const idx = currentLine.text.indexOf(marker);
              if (idx > 0 && /\s/.test(currentLine.text[idx - 1])) {
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

          // prevent saveVCM loop / re-extraction
          justInjectedFromVCM.add(doc.uri.fsPath);

          await vscode.commands.executeCommand("workbench.action.files.save");
        }

        // Refresh split view if open (use the correct read fn for split content)
        await updateSplitViewIfOpen(
          doc,
          provider,
          relativePath,
          getSplitViewState,
          (relativePath) => readSharedVCM(relativePath, vcmDir),
          (relativePath) => readPrivateVCM(relativePath, vcmPrivateDir)
        );

        vscode.window.showInformationMessage("VCM: Unmarked Private ✅");
        setTimeout(() => updateAlwaysShow(context, deps), 100);
      } catch (err) {
        vscode.window.showErrorMessage(
          "VCM: Error unmarking private: " + (err?.message || String(err))
        );
      } finally {
        setTimeout(() => (vcmSyncEnabled = true), 800);
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
        if (!isCommentedMap.has(doc.uri.fsPath)) {
          const detected = await detectInitialMode(doc, vcmDir);
          isCommentedMap.set(doc.uri.fsPath, detected);
        }
        if (!privateCommentsVisible.has(doc.uri.fsPath)) {
          const detectedPrivate = await detectPrivateVisibility(doc, relativePath);
          privateCommentsVisible.set(doc.uri.fsPath, detectedPrivate);
        }

        // Check if private VCM file exists
        const privateVCMExists = await vcmFileExists(vcmPrivateDir, relativePath);

        if (!privateVCMExists) {
          vscode.window.showInformationMessage("VCM: No private comments found in this file.");
          vcmSyncEnabled = true;
          return;
        }

        // Use stored state as source of truth (updated by undo/redo detection)
        // Toggle flips this state
        const storedState = privateCommentsVisible.get(doc.uri.fsPath);
        const currentlyVisible = storedState !== undefined ? storedState : false;
        const detected = await detectInitialMode(doc, vcmDir);
        const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath) === true;
        if (!isInCommentedMode && !currentlyVisible && !detected) {
          vscode.window.showInformationMessage("VCM: Private comments can only be shown in commented mode.");
          vcmSyncEnabled = true;
          return;
        }

        let newText;
        if (currentlyVisible) {
          // Toggling OFF: Private uses shared clean-mode behavior
          const config = vscode.workspace.getConfiguration("vcm");
          const sharedComments = await readSharedVCM(relativePath, vcmDir);
          const privateComments = await readPrivateVCM(relativePath, vcmPrivateDir);
          const privateContext = [...sharedComments, ...privateComments];
          newText = await cleanModeBehavior({
            doc,
            text,
            relativePath,
            config,
            saveVCM,
            vcmFileExists,
            vcmDir: vcmPrivateDir,
            readVCM: readPrivateVCM,
            contextComments: privateContext
          });

          privateCommentsVisible.set(doc.uri.fsPath, false);
          justInjectedFromPrivateVCM.add(doc.uri.fsPath);
          vscode.window.showInformationMessage("VCM: Private comments hidden 🔒");
        } else {
          // Toggling ON: Private uses shared commented-mode behavior
          newText = await commentedModeBehavior({
            doc,
            text,
            relativePath,
            saveVCM,
            readVCM: readPrivateVCM,
            writeVCM: writePrivateVCM,
            vcmDir: vcmPrivateDir,
            injectFn: injectMissingPrivateComments
          });

          privateCommentsVisible.set(doc.uri.fsPath, true);
          justInjectedFromPrivateVCM.add(doc.uri.fsPath);
          vscode.window.showInformationMessage("VCM: Private comments visible 🔓");
        }

        // Replace entire document content
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
        await vscode.workspace.applyEdit(edit);
        await vscode.commands.executeCommand("workbench.action.files.save");

        if (isCommentedMap.get(doc.uri.fsPath) === true) {
          await saveVCM(doc, true);
        }

        // Update split view efficiently by passing the private visibility state that was just set
        // This ensures split view stays in sync even with undo/redo
        await updateSplitViewIfOpen(
          doc,
          provider,
          relativePath,
          getSplitViewState,
          (relativePath) => readSharedVCM(relativePath, vcmDir),
          (relativePath) => readPrivateVCM(relativePath, vcmPrivateDir),
          !currentlyVisible // Pass the state we just toggled to: was visible -> now hidden (false), was hidden -> now visible (true)
        );

        // Re-enable sync after a delay to ensure save completes
        setTimeout(() => (vcmSyncEnabled = true), 800);
      } catch (err) {
        vscode.window.showErrorMessage(
          "VCM: Error toggling private comments: " + (err?.message || String(err))
        );
        console.error("togglePrivateComments error:", err);
        vcmSyncEnabled = true;
      }
    }
  );
  context.subscriptions.push(togglePrivateComments);

  // ---------------------------------------------------------------------------
  // COMMAND: Split view with/without comments
  // ---------------------------------------------------------------------------
  
  const toggleSplitView = vscode.commands.registerCommand("vcm-view-comments-mirror.toggleSplitViewComments", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const doc = editor.document;

    // Close any existing VCM split view before opening a new one (only one VCM_ allowed)
    if (tempUri) {
      await closeSplitView(getSplitViewState, _commentJumpIndexCache);
    }

    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const baseName = doc.fileName.split(/[\\/]/).pop();
    const vcmLabel = `VCM_${baseName}`;

    // Check if VCM exists first
    const vcmExists = await vcmFileExists(vcmDir, relativePath);
    const baseText = doc.getText();
    let showVersion;
    let labelType;

    if (!vcmExists) {
      // NO VCM EXISTS: Always show clean mode (strip all comments from source)
      const allComments = parseDocComs(baseText, doc.uri.path);
      showVersion = stripComments(baseText, doc.uri.path, allComments);
      labelType = "clean";

      // Save VCM for future use
      await saveVCM(doc, true);
    } else {
      // VCM EXISTS: Show opposite of current mode
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

      const isInCommentedMode = isCommentedMap.get(doc.uri.fsPath);
      const keepPrivate = privateCommentsVisible.get(doc.uri.fsPath) === true;

      // Load comments from VCM
      const sharedComments = await readSharedVCM(relativePath, vcmDir);
      const privateComments = await readPrivateVCM(relativePath, vcmPrivateDir);
      const mergedSharedComments = mergeSharedTextCleanMode(sharedComments);

      // Build clean version: always strip shared, conditionally strip private
      let cleanSharedStripped = stripComments(baseText, doc.uri.path, mergedSharedComments);
      let clean = keepPrivate
        ? cleanSharedStripped
        : stripComments(cleanSharedStripped, doc.uri.path, privateComments);

      // Build commented version: inject shared, conditionally inject private
      let withComments = injectComments(clean, doc.uri.path, mergedSharedComments, true, false);

      if (keepPrivate) {
        // Parse what's already in the text and build a set of existing comment keys
        const existing = parseDocComs(withComments, doc.uri.path);
        const existingKeys = new Set(existing.map(c => buildContextKey(c)));

        // Only inject private comments that are NOT already present
        const missingPrivate = privateComments.filter(c => !existingKeys.has(buildContextKey(c)));

        if (missingPrivate.length > 0) {
          withComments = injectComments(withComments, doc.uri.path, missingPrivate, true, true);
        }
      }

      // Show opposite of current mode
      showVersion = isInCommentedMode ? clean : withComments;
      labelType = isInCommentedMode ? "clean" : "with comments";
    }

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
        const clickedLineNumber = cursorPos.line;

        // Build (cached) indexes for both docs.
        // Always use *source file path* for comment marker detection.
        const sourceIndex = getCommentJumpIndexForDoc(sourceEditor.document, doc.uri.path);
        const splitIndex  = getCommentJumpIndexForDoc(vcmEditor.document, doc.uri.path);

        // Check if click was on a comment line (O(1)).
        const clickedComment = sourceIndex.lineToComment.get(clickedLineNumber);

        let targetLine = -1;

        if (clickedComment) {
          // Comment click: jump to the SAME comment in the split view via contextKey (O(1)).
          const key = buildContextKey(clickedComment);

          // Where does this comment exist in the split view?
          const matchLines = splitIndex.keyToLines.get(key);

          if (matchLines && matchLines.length > 0) {
            // If multiple matches, pick the closest one to the clicked line for better UX
            if (matchLines.length === 1) {
              targetLine = matchLines[0];
            } else {
              // Pick closest match by line distance
              targetLine = matchLines.reduce((closest, line) => {
                const closestDist = Math.abs(closest - clickedLineNumber);
                const lineDist = Math.abs(line - clickedLineNumber);
                return lineDist < closestDist ? line : closest;
              });
            }
          } else {
            // FALLBACK: comment doesn't exist in the split doc (because it's clean).
            // Jump to its anchor (code) instead.
            const anchorLines = splitIndex.anchorToLines.get(clickedComment.anchor);

            if (!anchorLines || anchorLines.length === 0) {
              return; // no safe jump target
            }

            if (anchorLines.length === 1) {
              targetLine = anchorLines[0];
            } else {
              // Multiple lines have the same anchor - use context hashes to disambiguate
              const splitLines = vcmEditor.document.getText().split("\n");
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);

              targetLine = anchorLines.find(lineIdx => {
                // Check if prev/next lines match the comment's context
                const prevLine = lineIdx > 0 ? splitLines[lineIdx - 1] : null;
                const nextLine = lineIdx < splitLines.length - 1 ? splitLines[lineIdx + 1] : null;

                const prevMatches = clickedComment.prevHash === null ||
                  (prevLine && hashLine(isolateCodeLine(prevLine, commentMarkers), 0) === clickedComment.prevHash);
                const nextMatches = clickedComment.nextHash === null ||
                  (nextLine && hashLine(isolateCodeLine(nextLine, commentMarkers), 0) === clickedComment.nextHash);

                return prevMatches && nextMatches;
              });

              // If context matching fails, fall back to proximity
              if (targetLine === undefined) {
                targetLine = anchorLines.reduce((closest, line) => {
                  const closestDist = Math.abs(closest - clickedLineNumber);
                  const lineDist = Math.abs(line - clickedLineNumber);
                  return lineDist < closestDist ? line : closest;
                });
              }
            }
          }
        } else {
          // Code click: keep your existing word/line heuristics.
          const wordRange = sourceEditor.document.getWordRangeAtPosition(cursorPos);
          if (!wordRange) return;

          const word = sourceEditor.document.getText(wordRange);
          if (!word || word.length < 2) return;

          const sourceLine = sourceEditor.document.lineAt(cursorPos.line).text.trim();
          const targetText = vcmEditor.document.getText();
          const targetLines = targetText.split("\n");

          targetLine = targetLines.findIndex(line => line.trim() === sourceLine.trim());
          if (targetLine === -1) {
            const wordRegex = new RegExp(`\\b${word}\\b`);
            targetLine = targetLines.findIndex(line => wordRegex.test(line));
          }
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
        const clickedLineNumber = cursorPos.line;

        // Cached indexes
        const sourceIndex = getCommentJumpIndexForDoc(sourceEditor.document, doc.uri.path);
        const splitIndex  = getCommentJumpIndexForDoc(vcmEditor.document, doc.uri.path);

        // Did we click on a comment line in the split view?
        const clickedComment = splitIndex.lineToComment.get(clickedLineNumber);

        let sourceLine = -1;

        if (clickedComment) {
          // Comment click: jump to same comment in source via contextKey (O(1))
          const key = buildContextKey(clickedComment);
          const matchLines = sourceIndex.keyToLines.get(key);

          if (matchLines && matchLines.length > 0) {
            // If multiple matches, pick the closest one for better UX
            if (matchLines.length === 1) {
              sourceLine = matchLines[0];
            } else {
              // Pick closest match by line distance
              sourceLine = matchLines.reduce((closest, line) => {
                const closestDist = Math.abs(closest - clickedLineNumber);
                const lineDist = Math.abs(line - clickedLineNumber);
                return lineDist < closestDist ? line : closest;
              });
            }
          } else {
            // FALLBACK: comment doesn't exist in source (because it's clean).
            // Jump to its anchor (code) instead.
            const anchorLines = sourceIndex.anchorToLines.get(clickedComment.anchor);

            if (!anchorLines || anchorLines.length === 0) {
              return; // no safe jump target
            }

            if (anchorLines.length === 1) {
              sourceLine = anchorLines[0];
            } else {
              // Multiple lines have the same anchor - use context hashes to disambiguate
              const sourceLines = sourceEditor.document.getText().split("\n");
              const commentMarkers = getCommentMarkersForFile(doc.uri.path);

              sourceLine = anchorLines.find(lineIdx => {
                // Check if prev/next lines match the comment's context
                const prevLine = lineIdx > 0 ? sourceLines[lineIdx - 1] : null;
                const nextLine = lineIdx < sourceLines.length - 1 ? sourceLines[lineIdx + 1] : null;

                const prevMatches = clickedComment.prevHash === null ||
                  (prevLine && hashLine(isolateCodeLine(prevLine, commentMarkers), 0) === clickedComment.prevHash);
                const nextMatches = clickedComment.nextHash === null ||
                  (nextLine && hashLine(isolateCodeLine(nextLine, commentMarkers), 0) === clickedComment.nextHash);

                return prevMatches && nextMatches;
              });

              // If context matching fails, fall back to proximity
              if (sourceLine === undefined) {
                sourceLine = anchorLines.reduce((closest, line) => {
                  const closestDist = Math.abs(closest - clickedLineNumber);
                  const lineDist = Math.abs(line - clickedLineNumber);
                  return lineDist < closestDist ? line : closest;
                });
              }
            }
          }
        } else {
          // Code click: keep your existing heuristic
          const wordRange = vcmEditor.document.getWordRangeAtPosition(cursorPos);
          if (!wordRange) return;

          const word = vcmEditor.document.getText(wordRange);
          if (!word || word.length < 2) return;
          // Extract line context to improve matching accuracy
          const splitLine = vcmEditor.document.lineAt(cursorPos.line).text.trim();
          const sourceText = sourceEditor.document.getText();
          const sourceLines = sourceText.split("\n");

          sourceLine = sourceLines.findIndex(line => line.trim() === splitLine.trim());
          if (sourceLine === -1) {
            const wordRegex = new RegExp(`\\b${word}\\b`);
            sourceLine = sourceLines.findIndex(line => wordRegex.test(line));
          }
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
