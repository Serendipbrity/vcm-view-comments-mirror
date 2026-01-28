# VCM (View Comments Mirror) - Complete End-to-End Data Flow

## 📋 Table of Contents
1. [System Overview](#system-overview)
2. [Entry Points & Commands](#entry-points--commands)
3. [Global State Management](#global-state-management)
4. [Mode System (Clean vs Commented)](#mode-system-clean-vs-commented)
5. [Private Comments System](#private-comments-system)
6. [AlwaysShow System](#alwaysshow-system)
7. [Comment Types (Line, Inline, Block)](#comment-types-line-inline-block)
8. [Complete Data Flow Examples](#complete-data-flow-examples)
9. [Architecture Diagrams](#architecture-diagrams)
10. [Module Reference](#module-reference)

---

## 🎯 System Overview

VCM is a VS Code extension that provides sophisticated comment management through three major mechanisms:

1. **Toggle Mode** - Hide/show comments in the same file (clean ↔ commented)
2. **Split View** - Side-by-side source and comment versions with click-to-jump navigation
3. **Private Comments** - Mark comments as private with separate visibility control

The system uses **hash-based anchoring** to track comments across code refactoring, allowing comments to survive line insertions, deletions, and edits.

**Storage Architecture:**
```
workspace/
├── .vcm/
│   ├── shared/          ← Regular comments (visible in commented mode)
│   │   └── {file}.vcm.json
│   └── private/         ← Private comments (separate toggle)
│       └── {file}.vcm.json
```

---

## 🚀 Entry Points & Commands

### 1. Toggle Current File Comments
**Command:** `vcm-view-comments-mirror.toggleCurrentFileComments`
**Shortcut:** Cmd+Vc (Mac) / Ctrl+Vc (Windows)
**Location:** `vcm.js:479-580`

**What it does:**
- Switches between clean mode (comments hidden) and commented mode (comments visible)
- Updates physical file content
- Saves/loads VCM files as needed

**Flow:**
```
User presses Cmd+Vc
         ↓
detectInitialMode(doc) → Check current mode
         ↓
   ┌─────┴─────┐
   ↓           ↓
COMMENTED    CLEAN
   ↓           ↓
Strip        Inject
Comments     Comments
   ↓           ↓
   └─────┬─────┘
         ↓
Update editor.edit()
         ↓
Save file & VCM
```

---

### 2. Toggle Split View
**Command:** `vcm-view-comments-mirror.toggleSplitViewComments`
**Shortcut:** Cmd+Alt+Vc (Mac) / Ctrl+Alt+Vc (Windows)
**Location:** `vcm.js:1187-1549`

**What it does:**
- Opens side-by-side view showing opposite version
- Left pane: Source document (actual file)
- Right pane: Virtual document (computed opposite)
- Bidirectional click-to-jump navigation
- Live syncs every 300ms

**Flow:**
```
User presses Cmd+Alt+Vc
         ↓
Detect current mode (clean/commented)
         ↓
Generate opposite version
         ↓
Create virtual document (vcm-view: URI)
         ↓
showTextDocument(virtualUri, ViewColumn.Two)
         ↓
setupBidirectionalJump() → Mouse click navigation
         ↓
watchDocument() → Auto-sync every 300ms
```

---

### 3. Toggle Private Comments
**Command:** `vcm-view-comments-mirror.togglePrivateComments`
**Shortcut:** Cmd+Shift+P (Mac) / Ctrl+Shift+P (Windows)
**Location:** `vcm.js:1088-1181`

**What it does:**
- Shows/hides ALL private comments in current file
- Uses clean mode behavior when turning OFF
- Uses commented mode behavior when turning ON

**Flow:**
```
User toggles private visibility
         ↓
Check privateCommentsVisible[file]
         ↓
   ┌─────┴─────┐
   ↓           ↓
 FALSE       TRUE
(Hidden)    (Visible)
   ↓           ↓
Use          Use
commented    clean
behavior     behavior
   ↓           ↓
Inject       Strip
private      private
comments     comments
   ↓           ↓
   └─────┬─────┘
         ↓
Set privateCommentsVisible[file] = !current
         ↓
Update split view if open
```

---

### 4. Mark as Private
**Command:** `vcm-view-comments-mirror.markCommentAsPrivate`
**Context Menu:** Right-click on comment
**Location:** `vcm.js:793-940`

**What it does:**
- Moves comment from shared VCM to private VCM
- If private visibility is OFF, immediately hides comment from editor
- Prevents saveVCM loops with `vcmSyncEnabled` flag

**Flow:**
```
User right-clicks on comment → "Mark as Private"
         ↓
parseDocComs(doc) → Extract all comments
         ↓
findCommentAtCursor(comments, cursorLine)
         ↓
Load both VCMs (shared + private)
         ↓
Remove comment from sharedComments[]
         ↓
Add comment to privateComments[]
         ↓
Set comment.isPrivate = true
         ↓
writeSharedVCM() + writePrivateVCM()
         ↓
IF privateCommentsVisible[file] === false:
  ├─ stripComments(doc, [comment])
  ├─ Save file
  └─ Show: "Private comment hidden 🔒"
ELSE:
  └─ Comment stays visible
```

---

### 5. Unmark Private
**Command:** `vcm-view-comments-mirror.unmarkCommentAsPrivate`
**Context Menu:** Right-click on private comment
**Location:** `vcm.js:946-1083`

**What it does:**
- Moves comment from private VCM back to shared VCM
- If in clean mode, removes comment from document (shared not visible there)

**Flow:**
```
User right-clicks on private comment → "Unmark Private"
         ↓
parseDocComs(doc) → Extract all comments
         ↓
findCommentAtCursor(comments, cursorLine)
         ↓
Load both VCMs (shared + private)
         ↓
Remove comment from privateComments[]
         ↓
Add comment to sharedComments[]
         ↓
Set comment.isPrivate = false
         ↓
writeSharedVCM() + writePrivateVCM()
         ↓
IF isCommented === false (clean mode):
  ├─ stripComments(doc, [comment])
  ├─ Save file
  └─ Show: "Unmarked private (hidden in clean mode)"
ELSE:
  └─ Comment stays visible
```

---

### 6. Mark as Always Show
**Command:** `vcm-view-comments-mirror.markCommentAlwaysShow`
**Context Menu:** Right-click on comment
**Location:** `vcm.js:585-665`

**What it does:**
- Marks comment to be visible even in clean mode
- Comment becomes "baked in" to the file
- Never stripped when toggling to clean mode

**Flow:**
```
User right-clicks on comment → "Mark as Always Show"
         ↓
parseDocComs(doc) → Extract all comments
         ↓
findCommentAtCursor(comments, cursorLine)
         ↓
Load shared VCM
         ↓
Find matching comment in VCM
         ↓
Set comment.alwaysShow = true
         ↓
writeSharedVCM()
         ↓
Show: "Comment marked as always visible ✓"
```

---

## 🗂️ Global State Management

**Location:** `vcm.js:35-58`

### State Variables

```javascript
// Split view tracking
let vcmEditor;          // Reference to split view editor
let tempUri;            // Virtual document URI (vcm-view: scheme)
let scrollListener;     // Bidirectional click-to-jump event listener
let sourceDocUri;       // Tracks which file has split view open

// VCM synchronization
let vcmSyncEnabled = true;  // Gates saveVCM() during toggles (prevents loops)

// Per-file state maps
let isCommentedMap = new Map();            // fsPath → boolean (true=commented, false=clean)
let justInjectedFromVCM = new Set();       // fsPath set (prevents re-extraction after injection)
let justInjectedFromPrivateVCM = new Set(); // fsPath set (prevents re-extraction after private toggle)
let privateCommentsVisible = new Map();    // fsPath → boolean (true=visible, false=hidden)
```

### State Lifecycle

**Initialization (activation):**
```javascript
function activate(context) {
  // Clear all state (prevents stale flags from previous session)
  isCommentedMap.clear();
  justInjectedFromVCM.clear();
  justInjectedFromPrivateVCM.clear();
  privateCommentsVisible.clear();

  // Create .vcm directories
  ensureVCMDirs();

  // Register virtual document provider for split view
  const provider = new VCMContentProvider();
  vscode.workspace.registerTextDocumentContentProvider('vcm-view', provider);
}
```

**Mode Detection (on toggle or split view):**
```javascript
const isCommented = detectInitialMode(doc, relativePath, vcmDir);
isCommentedMap.set(doc.uri.fsPath, isCommented);

const privateVisible = detectPrivateVisibility(doc, relativePath, vcmPrivateDir);
privateCommentsVisible.set(doc.uri.fsPath, privateVisible);
```

**Injection Flags (prevent re-extraction loops):**
```javascript
// After injecting from VCM
justInjectedFromVCM.add(doc.uri.fsPath);

// In saveVCM, check flag:
if (justInjectedFromVCM.has(doc.uri.fsPath)) {
  justInjectedFromVCM.delete(doc.uri.fsPath);
  return; // Skip saving (we just injected these comments)
}
```

---

## 🔄 Mode System (Clean vs Commented)

### Clean Mode
**Definition:** Comments are hidden from the editor

**Characteristics:**
- User sees only code
- Physical file on disk shows clean code
- Comments stored in `.vcm/shared/{file}.vcm.json`
- **Exception:** `alwaysShow` comments remain visible
- Edits to comments tracked in `text_cleanMode` field

**Detection Logic:**
```javascript
// detectModes.js:15-83
function detectInitialMode(doc, relativePath, vcmDir) {
  const sharedVCM = readSharedVCM(relativePath, vcmDir);

  if (!sharedVCM) {
    // No VCM exists
    const docComments = parseDocComs(doc.getText(), doc.uri.path);
    return docComments.length > 0; // true=commented, false=clean
  }

  // VCM exists - check if first toggleable comment is in document
  const docText = doc.getText();
  const toggleableComments = sharedVCM.comments.filter(c => !c.alwaysShow);

  if (toggleableComments.length === 0) {
    return false; // All comments are alwaysShow, treat as clean
  }

  const firstComment = toggleableComments[0];
  const searchText = getCommentText(firstComment);

  return docText.includes(searchText); // true=commented, false=clean
}
```

---

### Commented Mode
**Definition:** Comments are visible in the editor

**Characteristics:**
- Comments appear physically in the file
- User can edit comments directly
- VCM files updated on save to match current state
- Changes reflected immediately in storage

**When Saving (commented mode):**
```javascript
// vcm.js saveVCM() - Lines 251-477
function saveVCM(doc, allowCreate) {
  // 1. Parse current document
  const docComments = parseDocComs(doc.getText(), doc.uri.path);

  // 2. Load VCM files
  const sharedVCM = readSharedVCM(relativePath, vcmDir);
  const privateVCM = readPrivateVCM(relativePath, vcmPrivateDir);

  // 3. Build private key set
  const privateKeys = new Set(privateVCM.map(c => buildContextKey(c)));

  // 4. Enrich with consecutive anchors (for private comments)
  addPrimaryAnchors(docComments, privateKeys);

  // 5. Filter to shared comments only
  const sharedDocComments = docComments.filter(c => {
    const key = buildContextKey(c);
    if (privateKeys.has(key)) return false;
    // Also filter by text match
    return !privateVCM.some(pv => isSameComment(c, pv));
  });

  // 6. Merge with VCM
  const updatedShared = mergeIntoVCMs({
    isCommented: true,
    docComments: sharedDocComments,
    vcmComments: sharedVCM.comments,
    isPrivateMode: false,
    wasJustInjected: false
  });

  // 7. Write shared VCM
  writeSharedVCM(relativePath, updatedShared, vcmDir);

  // 8. Handle private if visible
  if (privateCommentsVisible.get(doc.uri.fsPath)) {
    const privateDocComments = docComments.filter(c => {
      const key = buildContextKey(c);
      return privateKeys.has(key);
    });

    const updatedPrivate = mergeIntoVCMs({
      isCommented: true,
      docComments: privateDocComments,
      vcmComments: privateVCM,
      isPrivateMode: true,
      wasJustInjected: false
    });

    writePrivateVCM(relativePath, updatedPrivate, vcmPrivateDir);
  }
}
```

---

### Toggle Flow: COMMENTED → CLEAN

**Location:** `vcm.js:506-529`

```
User presses Cmd+Vc (currently in commented mode)
         ↓
Detect current mode: isCommented = true
         ↓
Save VCM if needed (or liveSync disabled)
  ├─ parseDocComs(doc)
  ├─ mergeIntoVCMs()
  └─ writeSharedVCM()
         ↓
Read shared comments from VCM
         ↓
stripComments(docText, sharedComments)
  ├─ Filter out alwaysShow comments (never strip)
  ├─ For each comment:
  │   ├─ Block: Mark all lines for removal
  │   ├─ Line: Mark line for removal
  │   └─ Inline: Mark comment portion for character removal
  └─ Rebuild document with lines removed
         ↓
editor.edit() → Replace all text
         ↓
Set isCommentedMap[file] = false
         ↓
Mark justInjectedFromVCM (skip next saveVCM)
         ↓
File saved automatically (clean code only)
         ↓
Show: "VCM: Comments hidden (clean mode) ✓"
```

---

### Toggle Flow: CLEAN → COMMENTED

**Location:** `vcm.js:530-569`

```
User presses Cmd+Vc (currently in clean mode)
         ↓
Detect current mode: isCommented = false
         ↓
Try generateCommentedVersion():
  ├─ Read shared VCM comments
  ├─ mergeSharedTextCleanMode(docText, comments)
  │   ├─ For each comment with text_cleanMode:
  │   │   ├─ Update main text field
  │   │   └─ Delete text_cleanMode field
  │   └─ Return updated comments
  ├─ stripComments(docText, updatedComments)
  │   └─ Remove alwaysShow comments from processing
  ├─ injectComments(cleanText, commentsToInject)
  │   └─ Add comments back to document
  └─ writeSharedVCM() with cleaned comments
         ↓
IF generateCommentedVersion fails:
  ├─ Fallback: saveVCM(doc, allowCreate=true)
  ├─ stripComments(docText, allComments)
  └─ injectComments(cleanText, allComments)
         ↓
editor.edit() → Replace all text
         ↓
Set isCommentedMap[file] = true
         ↓
Mark justInjectedFromVCM (skip next saveVCM)
         ↓
File saved automatically (with comments visible)
         ↓
Show: "VCM: Comments visible (commented mode) ✓"
```

---

## 🔒 Private Comments System

### Architecture

**Two Separate VCM Storages:**
```
.vcm/
├── shared/              ← Regular comments
│   └── file.ts.vcm.json    (isPrivate: false or omitted)
└── private/             ← Private comments
    └── file.ts.vcm.json    (isPrivate: true)
```

**Private Comment States:**

| State | Private Visible | Storage Location | Visible in Editor |
|-------|----------------|------------------|-------------------|
| Shared comment | N/A | `.vcm/shared/` | Based on clean/commented mode |
| Private + ON | true | `.vcm/private/` | YES |
| Private + OFF | false | `.vcm/private/` | NO |

---

### Private Visibility Toggle

**Turning ON (false → true):**
```javascript
// vcm.js:1088-1181
async function togglePrivateComments() {
  const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) || false;

  if (!privateVisible) {
    // Currently OFF, turn ON (use commented mode behavior)
    const privateVCM = await readPrivateVCM(relativePath, vcmPrivateDir);

    if (privateVCM.length > 0) {
      // Generate version with private comments
      let updatedText = doc.getText();

      // Strip private comments first (in case some are visible)
      updatedText = stripComments(updatedText, privateVCM);

      // Inject private comments
      updatedText = injectComments(updatedText, privateVCM, doc.uri.path);

      // Update editor
      await editor.edit(editBuilder => {
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        editBuilder.replace(fullRange, updatedText);
      });

      // Save state
      privateCommentsVisible.set(doc.uri.fsPath, true);
      justInjectedFromPrivateVCM.add(doc.uri.fsPath);

      // Save file
      await doc.save();

      vscode.window.showInformationMessage('VCM: Private comments visible 🔓');
    }
  }
}
```

**Turning OFF (true → false):**
```javascript
if (privateVisible) {
  // Currently ON, turn OFF (use clean mode behavior)
  const privateVCM = await readPrivateVCM(relativePath, vcmPrivateDir);

  if (privateVCM.length > 0) {
    // Strip private comments
    let updatedText = doc.getText();
    updatedText = stripComments(updatedText, privateVCM);

    // Update editor
    await editor.edit(editBuilder => {
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length)
      );
      editBuilder.replace(fullRange, updatedText);
    });

    // Save state
    privateCommentsVisible.set(doc.uri.fsPath, false);
    justInjectedFromPrivateVCM.add(doc.uri.fsPath);

    // Save file
    await doc.save();

    vscode.window.showInformationMessage('VCM: Private comments hidden 🔒');
  }
}
```

---

### Mark Comment as Private

**Complete Flow:**
```
1. User right-clicks on comment → "Mark as Private"
         ↓
2. parseDocComs(doc.getText(), doc.uri.path)
   → Extract all comments from current document
         ↓
3. findCommentAtCursor(docComments, selectedLine)
   → Find the specific comment at cursor position
         ↓
4. Check if VCM exists
   IF no VCM:
     ├─ vcmSyncEnabled = false (prevent loop)
     ├─ await saveVCM(doc, allowCreate=true)
     ├─ vcmSyncEnabled = true
     └─ Reload VCMs
         ↓
5. Load both VCMs:
   ├─ sharedComments = await readSharedVCM(relativePath, vcmDir)
   └─ privateComments = await readPrivateVCM(relativePath, vcmPrivateDir)
         ↓
6. Remove from shared:
   sharedComments = sharedComments.filter(c => !isSameComment(c, commentAtCursor))
         ↓
7. Add to private:
   commentAtCursor.isPrivate = true
   privateComments.push(commentAtCursor)
         ↓
8. Write both VCMs:
   ├─ await writeSharedVCM(relativePath, sharedComments, vcmDir)
   └─ await writePrivateVCM(relativePath, privateComments, vcmPrivateDir)
         ↓
9. IF privateCommentsVisible[file] === false:
   ├─ Strip comment from document:
   │   ├─ const edit = new vscode.WorkspaceEdit()
   │   ├─ edit.delete(doc.uri, commentRange)
   │   └─ await vscode.workspace.applyEdit(edit)
   ├─ await doc.save()
   └─ Show: "VCM: Private comment hidden 🔒"
   ELSE:
     └─ Show: "VCM: Comment marked as private ✓"
         ↓
10. updateAlwaysShow(context, deps) → Refresh context menu
         ↓
11. updateSplitViewIfOpen() → Refresh split view if open
```

---

### Private Comment Enrichment

**Consecutive Private Comments Anchor to Each Other:**

```javascript
// parseDocComs.js:382-528
function addPrimaryAnchors(docComments, privateKeys) {
  // Find groups of consecutive private comments
  const privateGroups = [];
  let currentGroup = [];

  for (const comment of docComments) {
    const key = buildContextKey(comment);

    if (privateKeys.has(key)) {
      currentGroup.push(comment);
    } else {
      if (currentGroup.length >= 2) {
        privateGroups.push([...currentGroup]);
      }
      currentGroup = [];
    }
  }

  // For each group, add primary anchors
  for (const group of privateGroups) {
    for (let i = 0; i < group.length; i++) {
      const comment = group[i];

      if (i < group.length - 1) {
        // Not last comment - anchor to NEXT comment
        const nextComment = group[i + 1];
        comment.primaryAnchor = nextComment.anchor;
        comment.primaryPrevHash = nextComment.prevHash;
        comment.primaryNextHash = nextComment.nextHash;
      } else {
        // Last comment - anchor to code (normal)
        comment.primaryAnchor = comment.anchor;
        comment.primaryPrevHash = comment.prevHash;
        comment.primaryNextHash = comment.nextHash;
      }
    }
  }
}
```

**Why This Matters:**
- Private comment blocks can move together as a unit
- When code between consecutive private comments changes, they stay anchored to each other
- Only the last comment anchors to code
- Prevents private comments from drifting apart

---

## ⭐ AlwaysShow System

### Purpose
Comments marked `alwaysShow: true` remain visible even in clean mode.

### Behavior Differences

**Regular Comment:**
```
Clean Mode:    [HIDDEN] - Stored in VCM, not in file
Commented Mode: [VISIBLE] - In file physically
```

**AlwaysShow Comment:**
```
Clean Mode:    [VISIBLE] - Stays in file physically
Commented Mode: [VISIBLE] - In file physically
```

### Implementation

**1. Mark as AlwaysShow:**
```javascript
// vcm.js:585-665
async function markCommentAlwaysShow() {
  const docComments = parseDocComs(doc.getText(), doc.uri.path);
  const commentAtCursor = findCommentAtCursor(docComments, selectedLine);

  const sharedVCM = await readSharedVCM(relativePath, vcmDir);

  // Find matching comment in VCM
  const vcmComment = sharedVCM.comments.find(c => isSameComment(c, commentAtCursor));

  if (vcmComment) {
    // Mark as alwaysShow
    vcmComment.alwaysShow = true;

    // Write updated VCM
    await writeSharedVCM(relativePath, sharedVCM.comments, vcmDir);

    vscode.window.showInformationMessage('VCM: Comment marked as always visible ✓');
  }
}
```

**2. Injection Logic (always excluded):**
```javascript
// injectExtractComments.js:25
function injectComments(text, comments, filePath) {
  // Filter out alwaysShow comments - they're already in the file
  const commentsToInject = comments.filter(c => !isAlwaysShow(c));

  // ... inject non-alwaysShow comments only
}
```

**3. Stripping Logic (always preserved):**
```javascript
// injectExtractComments.js:374
function stripComments(text, comments, filePath) {
  // Filter out alwaysShow comments - never strip them
  const commentsToStrip = comments.filter(c => !isAlwaysShow(c));

  // ... strip non-alwaysShow comments only
}
```

**4. Clean Mode Edits:**
```javascript
// mergeIntoVCMs.js - Clean mode handling
if (!isCommented && !isPrivateMode) {
  // For alwaysShow comments, update directly (no text_cleanMode)
  if (isAlwaysShow(docComment)) {
    matchedComment.text = docComment.text; // Direct update
  } else {
    // For regular comments, track in text_cleanMode
    matchedComment.text_cleanMode = docComment.text;
  }
}
```

**5. Context Menu Visibility:**
```javascript
// vcm.js:69-83 updateAlwaysShow
function updateAlwaysShow(context, deps) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const docComments = parseDocComs(editor.document.getText(), editor.document.uri.path);
  const cursorLine = editor.selection.active.line;
  const commentAtCursor = findCommentAtCursor(docComments, cursorLine);

  // Enable "Unmark Always Show" menu item if on alwaysShow comment
  vscode.commands.executeCommand('setContext', 'vcm.commentIsAlwaysShow',
    commentAtCursor?.alwaysShow === true);
}
```

---

## 💬 Comment Types (Line, Inline, Block)

### Type Detection & Parsing

**Location:** `parseDocComs.js:14-380`

**Algorithm:**

```
PASS 1: Build set of comment-only line indices
  ├─ Scan for line markers (e.g., //, --, #) at line start
  ├─ Scan for block markers (e.g., /* */, <!-- -->) anywhere
  └─ Mark all lines that are purely comments
        ↓
PASS 2: Extract individual comments
  ├─ Iterate through each line
  ├─ Track block comment state (inside vs outside)
  ├─ Group consecutive line comments
  └─ Extract inline comments separately
```

---

### Line Comments

**Definition:** Standalone comment lines (no code on same line)

**Example:**
```javascript
// This is a line comment
// This is another line comment (grouped with above)
const x = 5;
```

**Parsing:**
```javascript
// parseDocComs.js:183-247
if (lineMarkerMatch && commentOnlyLines.has(i)) {
  // Line comment detected
  pendingLineComment.push(trimmedLine);

  if (i === lines.length - 1 || !commentOnlyLines.has(i + 1)) {
    // Last line in group - flush
    const commentText = pendingLineComment.join('\n');
    const nextCodeLine = findNextCodeLine(lines, i + 1);

    comments.push({
      type: 'line',
      text: commentText,
      commentedLineIndex: startIndex,
      anchor: hash(nextCodeLine),          // Next code line
      prevHash: hash(previousCodeLine),    // Previous code line
      nextHash: hash(lineAfterNextCode)    // Line after next code
    });

    pendingLineComment = [];
  }
}
```

**Anchoring:**
- `anchor`: Hash of the NEXT non-comment code line
- `prevHash`: Hash of the PREVIOUS non-comment code line
- `nextHash`: Hash of the line AFTER the anchor

**Injection:**
```javascript
// injectExtractComments.js:286-360
// Line comments inserted ABOVE their anchor line
for (const [lineIndex, lineText] of lines.entries()) {
  const lineHash = hashLine(lineText);

  // Insert line/block comments that anchor to this line
  const anchored = commentsForHash.get(lineHash) || [];
  for (const comment of anchored) {
    if (comment.type === 'line') {
      result.push(comment.text); // Insert above
    }
  }

  result.push(lineText); // Then the code line
}
```

---

### Inline Comments

**Definition:** Comments on same line as code

**Example:**
```javascript
const x = 5; // This is an inline comment
```

**Parsing:**
```javascript
// parseDocComs.js:268-330
if (!commentOnlyLines.has(i)) {
  // Code line - check for inline comment
  const inlineMatch = line.match(inlineCommentPattern);

  if (inlineMatch) {
    const commentText = inlineMatch[0]; // e.g., " // comment"
    const codePart = isolateCodeLine(line, filePath); // "const x = 5"

    comments.push({
      type: 'inline',
      text: commentText,
      commentedLineIndex: i,
      anchor: hash(codePart),           // Code portion only
      prevHash: hash(previousCodeLine), // Previous code line
      nextHash: hash(nextCodeLine)      // Next code line
    });
  }
}
```

**Anchoring:**
- `anchor`: Hash of the code portion ONLY (excluding comment)
- `prevHash`: Hash of the previous code line
- `nextHash`: Hash of the next code line

**Code Isolation:**
```javascript
// commentMarkers.js:129-221
function isolateCodeLine(line, filePath) {
  const markers = getCommentMarkers(filePath);

  // Remove inline comment portion
  for (const marker of markers.inline) {
    const index = line.indexOf(marker);
    if (index !== -1) {
      return line.slice(0, index).trimEnd();
    }
  }

  return line; // No inline comment found
}
```

**Injection:**
```javascript
// injectExtractComments.js:286-360
// Inline comments appended to same line
for (const [lineIndex, lineText] of lines.entries()) {
  const lineHash = hashLine(lineText);

  // Insert line/block comments first (above)
  // ...

  // Then insert the code line
  let finalLine = lineText;

  // Append inline comment if exists
  const inlineComment = inlineCommentsMap.get(lineHash);
  if (inlineComment) {
    finalLine += inlineComment.text;
  }

  result.push(finalLine);
}
```

---

### Block Comments

**Definition:** Multi-line delimited comments

**Example:**
```javascript
/* This is
   a block
   comment */
const x = 5;
```

**Parsing:**
```javascript
// parseDocComs.js:85-181
if (blockStartMatch) {
  const blockEndMatch = line.match(blockEndPattern);

  if (blockEndMatch) {
    // One-line block comment
    const commentText = line.trim();
    const nextCodeLine = findNextCodeLine(lines, i + 1);

    comments.push({
      type: 'block',
      block: [commentText],
      commentedLineIndex: i,
      anchor: hash(nextCodeLine),
      prevHash: hash(previousCodeLine),
      nextHash: hash(lineAfterNextCode)
    });
  } else {
    // Multi-line block starts
    inBlock = true;
    blockBuffer.push(line);
  }
} else if (inBlock) {
  blockBuffer.push(line);

  if (blockEndMatch) {
    // Block ends
    inBlock = false;
    const nextCodeLine = findNextCodeLine(lines, i + 1);

    comments.push({
      type: 'block',
      block: blockBuffer.slice(), // Array of lines
      commentedLineIndex: startLineIndex,
      anchor: hash(nextCodeLine),
      prevHash: hash(previousCodeLine),
      nextHash: hash(lineAfterNextCode)
    });

    blockBuffer = [];
  }
}
```

**Storage Format:**
```javascript
{
  type: 'block',
  block: [
    '/* This is',
    '   a block',
    '   comment */'
  ],
  commentedLineIndex: 42,
  anchor: 'abc123',
  prevHash: 'def456',
  nextHash: 'ghi789'
}
```

**Anchoring:**
- `anchor`: Hash of the first non-comment line AFTER the block
- `prevHash`: Hash of the last code line BEFORE the block
- `nextHash`: Hash of the line after the anchor

**Injection:**
```javascript
// injectExtractComments.js:286-360
// Block comments inserted ABOVE their anchor line
for (const [lineIndex, lineText] of lines.entries()) {
  const lineHash = hashLine(lineText);

  const anchored = commentsForHash.get(lineHash) || [];
  for (const comment of anchored) {
    if (comment.type === 'block') {
      // Insert all block lines
      for (const blockLine of comment.block) {
        result.push(blockLine);
      }
    }
  }

  result.push(lineText); // Then the code line
}
```

**Header Block Handling:**
```javascript
// parseDocComs.js:156-175
if (comment.type === 'block' && !comment.prevHash) {
  // Header block (no previous code)
  // Preserve trailing blank lines
  const lastBlockLine = comment.commentedLineIndex + comment.block.length - 1;
  let trailingBlanks = 0;

  for (let j = lastBlockLine + 1; j < lines.length; j++) {
    if (lines[j].trim() === '') {
      trailingBlanks++;
    } else {
      break;
    }
  }

  comment.trailingBlankLines = trailingBlanks;
}
```

---

## 🌊 Complete Data Flow Examples

### Example 1: Toggle from Commented to Clean Mode

**Initial State:**
```javascript
// File: example.js
const x = 5; // inline comment
// line comment
const y = 10;
```

**User Action:** Presses `Cmd+Vc`

**Complete Flow:**

```
1. User presses Cmd+Vc
         ↓
2. toggleCurrentFileComments() handler triggered
   vcm.js:479
         ↓
3. Detect current mode:
   const isCommented = detectInitialMode(doc, relativePath, vcmDir)
   Result: true (comments visible)
         ↓
4. COMMENTED → CLEAN branch (vcm.js:506-529)
         ↓
5. Save VCM (if needed):
   IF (!vcmExists || !liveSync):
     ├─ parseDocComs(doc.getText(), doc.uri.path)
     │   Returns: [
     │     {type: 'inline', text: ' // inline comment', anchor: 'hash(const x = 5)', ...},
     │     {type: 'line', text: '// line comment', anchor: 'hash(const y = 10)', ...}
     │   ]
     ├─ Load existing VCMs
     ├─ mergeIntoVCMs(isCommented=true, docComments, vcmComments)
     └─ writeSharedVCM()
         ↓
6. Read shared comments:
   const sharedVCM = await readSharedVCM(relativePath, vcmDir)
   Result: {
     file: 'example.js',
     lastModified: '2026-01-03T...',
     comments: [
       {type: 'inline', text: ' // inline comment', ...},
       {type: 'line', text: '// line comment', ...}
     ]
   }
         ↓
7. Strip comments:
   let updatedText = doc.getText()
   updatedText = stripComments(updatedText, sharedVCM.comments, doc.uri.path)

   stripComments() process:
     ├─ Parse document again to get current positions
     ├─ Filter out alwaysShow comments (keep those)
     ├─ For inline comment:
     │   └─ Remove " // inline comment" portion from line
     ├─ For line comment:
     │   └─ Remove entire line "// line comment"
     └─ Return: "const x = 5\nconst y = 10"
         ↓
8. Update editor:
   await editor.edit(editBuilder => {
     const fullRange = new vscode.Range(/* full document */);
     editBuilder.replace(fullRange, updatedText);
   });
         ↓
9. Update state:
   isCommentedMap.set(doc.uri.fsPath, false)
   justInjectedFromVCM.add(doc.uri.fsPath)
         ↓
10. Save file:
    await doc.save()

    onDidSaveTextDocument triggers:
      ├─ saveVCM() called
      ├─ Check justInjectedFromVCM flag
      ├─ Flag is set, so SKIP processing
      └─ Clear flag
         ↓
11. Update split view (if open):
    updateSplitViewIfOpen()
         ↓
12. Show message:
    "VCM: Comments hidden (clean mode) ✓"
```

**Final State:**
```javascript
// File: example.js (on disk)
const x = 5
const y = 10
```

**VCM File:**
```json
{
  "file": "example.js",
  "lastModified": "2026-01-03T15:30:00.000Z",
  "comments": [
    {
      "type": "inline",
      "text": " // inline comment",
      "anchor": "abc123",
      "prevHash": "",
      "nextHash": "def456",
      "commentedLineIndex": 0
    },
    {
      "type": "line",
      "text": "// line comment",
      "anchor": "def456",
      "prevHash": "abc123",
      "nextHash": "",
      "commentedLineIndex": 1
    }
  ]
}
```

---

### Example 2: Mark Comment as Private (Private Visibility OFF)

**Initial State:**
```javascript
// File: example.js (commented mode)
const x = 5; // shared comment
const y = 10; // private comment (cursor here)
```

**User Action:** Right-click on line 2 → "Mark as Private"

**Complete Flow:**

```
1. User right-clicks → "Mark as Private"
   vcm.js:793
         ↓
2. Parse document:
   const docComments = parseDocComs(doc.getText(), doc.uri.path)
   Result: [
     {type: 'inline', text: ' // shared comment', ...},
     {type: 'inline', text: ' // private comment', ...}
   ]
         ↓
3. Find comment at cursor:
   const selectedLine = editor.selection.active.line; // 1
   const commentAtCursor = findCommentAtCursor(docComments, selectedLine)
   Result: {type: 'inline', text: ' // private comment', ...}
         ↓
4. Check if VCM exists:
   const sharedExists = await vcmFileExists(relativePath, vcmDir)
   const privateExists = await vcmFileExists(relativePath, vcmPrivateDir)

   IF (!sharedExists && !privateExists):
     ├─ vcmSyncEnabled = false (prevent loop)
     ├─ await saveVCM(doc, allowCreate=true)
     ├─ vcmSyncEnabled = true
     └─ Reload both VCMs
         ↓
5. Load VCMs:
   sharedComments = await readSharedVCM(relativePath, vcmDir)
   Result: [
     {type: 'inline', text: ' // shared comment', ...},
     {type: 'inline', text: ' // private comment', ...}
   ]

   privateComments = await readPrivateVCM(relativePath, vcmPrivateDir)
   Result: []
         ↓
6. Remove from shared:
   sharedComments = sharedComments.filter(c => !isSameComment(c, commentAtCursor))

   isSameComment() logic:
     ├─ Build context keys:
     │   key1 = "inline:hash(const y = 10):hash(const x = 5):hash_empty"
     │   key2 = "inline:hash(const y = 10):hash(const x = 5):hash_empty"
     ├─ Match by key: TRUE
     └─ Return: true (same comment)

   Result: sharedComments = [
     {type: 'inline', text: ' // shared comment', ...}
   ]
         ↓
7. Add to private:
   commentAtCursor.isPrivate = true
   privateComments.push(commentAtCursor)

   Result: privateComments = [
     {type: 'inline', text: ' // private comment', isPrivate: true, ...}
   ]
         ↓
8. Write both VCMs:
   await writeSharedVCM(relativePath, sharedComments, vcmDir)
   → .vcm/shared/example.js.vcm.json (1 comment)

   await writePrivateVCM(relativePath, privateComments, vcmPrivateDir)
   → .vcm/private/example.js.vcm.json (1 comment)
         ↓
9. Check private visibility:
   const privateVisible = privateCommentsVisible.get(doc.uri.fsPath) || false
   Result: false (default)
         ↓
10. Strip private comment from document:
    const commentRange = new vscode.Range(
      new vscode.Position(1, 14), // Start of comment
      new vscode.Position(1, 32)  // End of line
    )

    const edit = new vscode.WorkspaceEdit()
    edit.delete(doc.uri, commentRange)
    await vscode.workspace.applyEdit(edit)
         ↓
11. Mark state and save:
    vcmSyncEnabled = false
    await doc.save()
    vcmSyncEnabled = true

    privateCommentsVisible.set(doc.uri.fsPath, false)
         ↓
12. Update UI:
    updateAlwaysShow(context, deps)
    updateSplitViewIfOpen()
         ↓
13. Show message:
    "VCM: Private comment hidden 🔒 Toggle Private Comments to view"
```

**Final State:**
```javascript
// File: example.js (on disk)
const x = 5; // shared comment
const y = 10
```

**Shared VCM (.vcm/shared/example.js.vcm.json):**
```json
{
  "file": "example.js",
  "lastModified": "2026-01-03T15:35:00.000Z",
  "comments": [
    {
      "type": "inline",
      "text": " // shared comment",
      "anchor": "abc123",
      "prevHash": "",
      "nextHash": "def456",
      "commentedLineIndex": 0
    }
  ]
}
```

**Private VCM (.vcm/private/example.js.vcm.json):**
```json
{
  "file": "example.js",
  "lastModified": "2026-01-03T15:35:00.000Z",
  "comments": [
    {
      "type": "inline",
      "text": " // private comment",
      "anchor": "def456",
      "prevHash": "abc123",
      "nextHash": "",
      "commentedLineIndex": 1,
      "isPrivate": true
    }
  ]
}
```

---

### Example 3: Toggle Split View with Click-to-Jump

**Initial State:**
```javascript
// File: example.js (clean mode)
const x = 5
const y = 10
```

**User Action:** Presses `Cmd+Alt+Vc`

**Complete Flow:**

```
1. User presses Cmd+Alt+Vc
   vcm.js:1187
         ↓
2. Check if split view already open:
   IF (sourceDocUri === doc.uri.toString()):
     ├─ Close split view
     └─ EXIT
         ↓
3. Detect current mode:
   const isCommented = detectInitialMode(doc, relativePath, vcmDir)
   Result: false (clean mode)
         ↓
4. Generate opposite version (commented):
   const oppositeText = await generateCommentedVersion({
     editor,
     relativePath,
     vcmDir,
     vcmPrivateDir
   })

   generateCommentedVersion() process:
     ├─ Read shared VCM comments
     ├─ mergeSharedTextCleanMode(docText, comments)
     ├─ stripComments(docText, updatedComments)
     ├─ injectComments(cleanText, commentsToInject)
     └─ Return commented version

   Result: "const x = 5; // shared comment\n// line comment\nconst y = 10"
         ↓
5. Create virtual document:
   const scheme = 'vcm-view'
   const virtualUri = vscode.Uri.parse(`${scheme}:${doc.uri.path}`)

   Update content provider:
   provider.update(virtualUri, oppositeText)
         ↓
6. Open split view:
   vcmEditor = await vscode.window.showTextDocument(virtualUri, {
     viewColumn: vscode.ViewColumn.Two,
     preserveFocus: false,
     preview: false
   })

   sourceDocUri = doc.uri.toString()
         ↓
7. Setup bidirectional click-to-jump:

   A. Build comment jump indexes for both documents:

   Source document index:
   {
     lineToComment: Map {
       // No comments (clean mode)
     },
     keyToLines: Map {},
     anchorToLines: Map {
       hash(const x = 5) → [0],
       hash(const y = 10) → [1]
     }
   }

   Split view index:
   {
     lineToComment: Map {
       0 → {type: 'inline', text: ' // shared comment', ...},
       1 → {type: 'line', text: '// line comment', ...}
     },
     keyToLines: Map {
       'inline:abc123:...:...' → [0],
       'line:def456:...:...' → [1]
     },
     anchorToLines: Map {
       hash(const x = 5) → [0],
       hash(const y = 10) → [2]
     }
   }
         ↓
   B. Register mouse click listener:
   scrollListener = vscode.window.onDidChangeTextEditorSelection(async e => {
     if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;

     // Determine direction
     const isSourceClick = e.textEditor.document.uri.scheme === 'file';
     const isVcmClick = e.textEditor.document.uri.scheme === 'vcm-view';

     if (isSourceClick) {
       // Source → Split View jump
       handleSourceToVcmJump(e);
     } else if (isVcmClick) {
       // Split View → Source jump
       handleVcmToSourceJump(e);
     }
   });
         ↓
8. Setup live sync (300ms debounce):
   splitViewManager.watchDocument({
     sourceEditor: editor,
     vcmEditor: vcmEditor,
     provider: provider,
     vcmDir,
     vcmPrivateDir
   })

   Watch triggers on:
     ├─ Document changes
     ├─ Undo/redo (re-detect modes)
     └─ Content modifications
         ↓
9. Show message:
   "VCM: Split view opened ✓"
```

**User Clicks on Line 0 in Split View (inline comment):**

```
1. Mouse click detected in split view editor
   vcm.js:1419
         ↓
2. Get clicked line:
   const clickedLine = e.selections[0].active.line; // 0
         ↓
3. Get split view jump index (cached):
   const vcmIndex = commentJumpIndexCache.get(vcmEditorKey)
         ↓
4. Check if click was on comment:
   const clickedComment = vcmIndex.lineToComment.get(clickedLine)
   Result: {type: 'inline', text: ' // shared comment', anchor: 'abc123', ...}
         ↓
5. Build context key:
   const contextKey = buildContextKey(clickedComment)
   Result: "inline:abc123:...:..."
         ↓
6. Find matching comment in source:
   const sourceIndex = commentJumpIndexCache.get(sourceEditorKey)
   const targetLines = sourceIndex.keyToLines.get(contextKey)
   Result: [] (comment not in source - clean mode)
         ↓
7. Fallback to anchor (code line):
   const anchorLines = sourceIndex.anchorToLines.get(clickedComment.anchor)
   Result: [0] (line with "const x = 5")
         ↓
8. Jump to source line:
   const targetLine = anchorLines[0]; // 0

   editor.selection = new vscode.Selection(targetLine, 0, targetLine, 0);
   editor.revealRange(
     new vscode.Range(targetLine, 0, targetLine, 0),
     vscode.TextEditorRevealType.InCenter
   );
         ↓
9. Source editor now shows line 0 centered
```

---

### Example 4: Editing Comment in Clean Mode

**Initial State:**
```javascript
// File: example.js (clean mode)
const x = 5
```

**VCM State:**
```json
{
  "comments": [
    {
      "type": "inline",
      "text": " // original comment",
      "anchor": "abc123"
    }
  ]
}
```

**User Action:** Toggles to commented mode, edits comment, toggles back to clean

**Complete Flow:**

```
1. User toggles to commented mode (Cmd+Vc)
         ↓
2. generateCommentedVersion():
   ├─ Load VCM: " // original comment"
   ├─ Inject comment into document
   └─ Result: "const x = 5; // original comment"
         ↓
3. User edits comment to: " // edited comment"
   Document now: "const x = 5; // edited comment"
         ↓
4. User saves file (Cmd+S)
   onDidSaveTextDocument → saveVCM()
         ↓
5. saveVCM() in commented mode:
   ├─ Parse document:
   │   docComments = [{type: 'inline', text: ' // edited comment', ...}]
   ├─ Load VCM:
   │   vcmComments = [{type: 'inline', text: ' // original comment', ...}]
   ├─ mergeIntoVCMs(isCommented=true, docComments, vcmComments):
   │   ├─ Match by context key
   │   ├─ Update VCM comment text: " // edited comment"
   │   └─ Return updated VCM
   └─ writeSharedVCM()
         ↓
6. User toggles to clean mode (Cmd+Vc)
         ↓
7. COMMENTED → CLEAN:
   ├─ stripComments() removes " // edited comment"
   └─ Result: "const x = 5"
         ↓
8. VCM now contains: " // edited comment" ✓
```

**Alternative: Edit in Clean Mode (with alwaysShow):**

```
1. Comment marked as alwaysShow
   VCM: {text: " // original", alwaysShow: true}
   Document (clean mode): "const x = 5; // original"
         ↓
2. User edits in clean mode:
   Document: "const x = 5; // edited in clean"
         ↓
3. User saves file (Cmd+S)
   onDidSaveTextDocument → saveVCM()
         ↓
4. saveVCM() in clean mode:
   ├─ Parse document:
   │   docComments = [{type: 'inline', text: ' // edited in clean', alwaysShow: true}]
   ├─ Load VCM:
   │   vcmComments = [{type: 'inline', text: ' // original', alwaysShow: true}]
   ├─ mergeIntoVCMs(isCommented=false, docComments, vcmComments):
   │   ├─ Match by context key
   │   ├─ For alwaysShow comment, update directly:
   │   │   matchedComment.text = " // edited in clean"
   │   └─ Return updated VCM
   └─ writeSharedVCM()
         ↓
5. VCM updated: {text: " // edited in clean", alwaysShow: true} ✓
```

**Alternative: Edit Non-AlwaysShow in Clean Mode:**

```
1. Regular comment (not alwaysShow)
   VCM: {text: " // original"}
   Document (clean mode): "const x = 5" (comment hidden)
         ↓
2. User somehow types comment manually:
   Document: "const x = 5; // manually typed"
         ↓
3. User saves file (Cmd+S)
   onDidSaveTextDocument → saveVCM()
         ↓
4. saveVCM() in clean mode:
   ├─ Parse document:
   │   docComments = [{type: 'inline', text: ' // manually typed', ...}]
   ├─ Load VCM:
   │   vcmComments = [{type: 'inline', text: ' // original', ...}]
   ├─ mergeIntoVCMs(isCommented=false, docComments, vcmComments):
   │   ├─ Match by context key
   │   ├─ For NON-alwaysShow, use text_cleanMode:
   │   │   matchedComment.text_cleanMode = " // manually typed"
   │   │   matchedComment.text = " // original" (unchanged)
   │   └─ Return updated VCM
   └─ writeSharedVCM()
         ↓
5. VCM contains both versions:
   {
     text: " // original",
     text_cleanMode: " // manually typed"
   }
         ↓
6. User toggles to commented mode (Cmd+Vc)
         ↓
7. CLEAN → COMMENTED:
   ├─ mergeSharedTextCleanMode():
   │   ├─ For each comment with text_cleanMode:
   │   │   ├─ comment.text = comment.text_cleanMode
   │   │   └─ delete comment.text_cleanMode
   │   └─ Return: {text: " // manually typed"}
   ├─ injectComments() with merged text
   └─ Result: "const x = 5; // manually typed" ✓
```

---

## 🏗️ Architecture Diagrams

### System Overview

```
┌────────────────────────────────────────────────────────────────┐
│                      VS CODE EDITOR                            │
│  ┌──────────────────────┐         ┌───────────────────────┐   │
│  │  Source Document     │         │  Split View (Virtual) │   │
│  │  (Physical File)     │◄───────►│  (vcm-view: scheme)   │   │
│  │                      │  Sync   │                       │   │
│  │ • Clean Mode OR      │  300ms  │ • Opposite Version    │   │
│  │ • Commented Mode     │         │ • Click-to-Jump       │   │
│  └──────────┬───────────┘         └───────────────────────┘   │
│             │                                                  │
│             ├─ Cmd+Vc (Toggle Mode)                           │
│             ├─ Cmd+Alt+Vc (Split View)                        │
│             ├─ Cmd+Shift+P (Toggle Private)                   │
│             └─ Right-click (Mark Private/AlwaysShow)          │
└─────────────┼──────────────────────────────────────────────────┘
              │
    ┌─────────▼──────────────────────────────────────┐
    │       PARSING & TRANSFORMATION LAYER           │
    │                                                 │
    │  ┌───────────────────────────────────────────┐ │
    │  │ parseDocComs(text, filePath)              │ │
    │  │ → Extract comments with context hashes    │ │
    │  │ Returns: [{type, text, anchor, ...}]      │ │
    │  └─────────────────┬─────────────────────────┘ │
    │                    │                            │
    │  ┌─────────────────▼─────────────────────────┐ │
    │  │ addPrimaryAnchors()            │ │
    │  │ → Private comments anchor to each other   │ │
    │  │ Adds: primaryAnchor, primaryPrevHash, ... │ │
    │  └─────────────────┬─────────────────────────┘ │
    │                    │                            │
    │  ┌─────────────────▼─────────────────────────┐ │
    │  │ injectComments / stripComments            │ │
    │  │ → Add/remove comments to/from document    │ │
    │  │ Uses anchor hashing for insertion points  │ │
    │  └─────────────────┬─────────────────────────┘ │
    │                    │                            │
    │  ┌─────────────────▼─────────────────────────┐ │
    │  │ mergeIntoVCMs()                           │ │
    │  │ → Reconcile document ↔ VCM state          │ │
    │  │ → Update metadata (alwaysShow, isPrivate) │ │
    │  └───────────────────────────────────────────┘ │
    └──────────────────┬──────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         │                            │
   ┌─────▼────────────┐      ┌───────▼─────────────┐
   │  SHARED VCM      │      │  PRIVATE VCM        │
   │                  │      │                     │
   │ readSharedVCM()  │      │ readPrivateVCM()    │
   │ writeSharedVCM() │      │ writePrivateVCM()   │
   │                  │      │                     │
   │ .vcm/shared/     │      │ .vcm/private/       │
   │ {file}.vcm.json  │      │ {file}.vcm.json     │
   │                  │      │                     │
   │ Visible:         │      │ Visible:            │
   │ • Commented Mode │      │ • Private Toggle ON │
   │ • AlwaysShow     │      │                     │
   └──────────────────┘      └─────────────────────┘
```

---

### State Machine: Mode Transitions

```
┌─────────────────────────────────────────────────────────────┐
│                    CLEAN MODE                               │
│                                                             │
│  • Comments hidden from editor                             │
│  • File shows only code                                    │
│  • VCM contains all comment metadata                       │
│  • AlwaysShow comments still visible                       │
│  • isCommentedMap[file] = false                           │
└──────┬──────────────────────────────────────────────▲──────┘
       │                                               │
       │ Cmd+Vc                                        │ Cmd+Vc
       │ (CLEAN → COMMENTED)                           │ (COMMENTED → CLEAN)
       │                                               │
       │ Actions:                                      │ Actions:
       │ 1. Read VCM                                   │ 1. Save VCM (if needed)
       │ 2. mergeSharedTextCleanMode()                 │ 2. Read VCM
       │ 3. injectComments()                           │ 3. stripComments()
       │ 4. Save file                                  │ 4. Save file
       │                                               │
       ↓                                               │
┌─────────────────────────────────────────────────────────────┐
│                  COMMENTED MODE                             │
│                                                             │
│  • Comments visible in editor                              │
│  • File shows code + comments                              │
│  • VCM updated on each save                                │
│  • Can edit comments directly                              │
│  • isCommentedMap[file] = true                            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              PRIVATE COMMENTS (Orthogonal)                  │
│                                                             │
│  OFF (hidden)                    ON (visible)               │
│  • Private stripped              • Private injected         │
│  • Stored in private VCM         • Editable in document     │
│  • privateVisible[file]=false    • privateVisible[file]=true│
│                                                             │
│  Toggle: Cmd+Shift+P                                        │
│  Mark: Right-click → "Mark as Private"                      │
└─────────────────────────────────────────────────────────────┘
```

---

### Comment Injection Algorithm

```
INPUT: Clean text + Comments array

STEP 1: Build hash maps
  ┌────────────────────────────────────────────┐
  │ For each code line in document:            │
  │   hash = hash(lineText)                    │
  │   hashToLines[hash].push(lineIndex)        │
  │   (One code line can have multiple hashes) │
  └────────────────────────────────────────────┘
         ↓
STEP 2: Group comments by anchor
  ┌────────────────────────────────────────────┐
  │ For each comment:                          │
  │   anchorHash = comment.anchor              │
  │   commentsForHash[anchorHash].push(comment)│
  └────────────────────────────────────────────┘
         ↓
STEP 3: Separate inline from block/line
  ┌────────────────────────────────────────────┐
  │ inlineComments = comments.filter(inline)   │
  │ blockLineComments = comments.filter(other) │
  └────────────────────────────────────────────┘
         ↓
STEP 4: Find insertion points
  ┌────────────────────────────────────────────┐
  │ For each comment:                          │
  │   candidates = hashToLines[comment.anchor] │
  │   IF multiple matches:                     │
  │     bestMatch = findBestMatch():           │
  │       - Score by prevHash match (+10)      │
  │       - Score by nextHash match (+10)      │
  │       - Tiebreak by distance from original │
  │   ELSE:                                    │
  │     bestMatch = candidates[0]              │
  └────────────────────────────────────────────┘
         ↓
STEP 5: Rebuild document
  ┌────────────────────────────────────────────┐
  │ result = []                                │
  │ For each code line:                        │
  │   lineHash = hash(lineText)                │
  │                                            │
  │   // Insert block/line comments above      │
  │   anchored = commentsForHash[lineHash]     │
  │   For each anchored comment:               │
  │     IF block:                              │
  │       result.push(...comment.block)        │
  │     IF line:                               │
  │       result.push(comment.text)            │
  │                                            │
  │   // Insert code line                      │
  │   finalLine = lineText                     │
  │                                            │
  │   // Append inline comment if exists       │
  │   inline = inlineComments[lineHash]        │
  │   IF inline:                               │
  │     finalLine += inline.text               │
  │                                            │
  │   result.push(finalLine)                   │
  └────────────────────────────────────────────┘
         ↓
OUTPUT: Commented text
```

---

### Split View Click-to-Jump

```
┌────────────────────────┐         ┌────────────────────────┐
│   SOURCE EDITOR        │         │   SPLIT VIEW EDITOR    │
│   (file: scheme)       │         │   (vcm-view: scheme)   │
│                        │         │                        │
│ Line 0: const x = 5    │         │ Line 0: const x = 5 // │
│ Line 1: const y = 10   │         │ Line 1: // comment     │
│                        │         │ Line 2: const y = 10   │
└────────┬───────────────┘         └────────┬───────────────┘
         │                                  │
         │ Mouse Click                      │ Mouse Click
         ↓                                  ↓
┌─────────────────────────┐       ┌─────────────────────────┐
│ Build Jump Index        │       │ Build Jump Index        │
│                         │       │                         │
│ lineToComment: {}       │       │ lineToComment: {        │
│                         │       │   0: inline comment,    │
│ keyToLines: {}          │       │   1: line comment       │
│                         │       │ }                       │
│ anchorToLines: {        │       │                         │
│   hash(x=5) → [0],      │       │ keyToLines: {           │
│   hash(y=10) → [1]      │       │   "inline:..." → [0],   │
│ }                       │       │   "line:..." → [1]      │
│                         │       │ }                       │
│ Cached!                 │       │                         │
└─────────────────────────┘       │ anchorToLines: {        │
         ↓                        │   hash(x=5) → [0],      │
┌─────────────────────────┐       │   hash(y=10) → [2]      │
│ Click on Line 0         │       │ }                       │
│                         │       │                         │
│ 1. Get clicked comment  │       │ Cached!                 │
│    → None (no comment)  │       └─────────────────────────┘
│                         │                ↓
│ 2. Get line hash        │       ┌─────────────────────────┐
│    → hash(const x = 5)  │       │ Click on Line 1         │
│                         │       │ (line comment)          │
│ 3. Find in split view:  │       │                         │
│    anchorToLines        │       │ 1. Get clicked comment  │
│    → [0]                │       │    → line comment obj   │
│                         │       │                         │
│ 4. Jump to line 0       │       │ 2. Build context key    │
│    in split view        │       │    → "line:def456:..." │
└─────────────────────────┘       │                         │
                                  │ 3. Find in source:      │
                                  │    keyToLines           │
                                  │    → [] (not in clean)  │
                                  │                         │
                                  │ 4. Fallback to anchor:  │
                                  │    hash(const y = 10)   │
                                  │    → [1]                │
                                  │                         │
                                  │ 5. Jump to line 1       │
                                  │    in source            │
                                  └─────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   INDEX CACHING STRATEGY                    │
│                                                             │
│  Key: `${documentUri}:${documentVersion}`                   │
│                                                             │
│  Invalidated when:                                          │
│  • Document version changes                                 │
│  • Document text modified                                   │
│                                                             │
│  Enables:                                                   │
│  • O(1) comment lookup on click                             │
│  • Fast duplicate resolution                                │
│  • Efficient bidirectional navigation                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Module Reference

### Core Modules

| Module | Location | Purpose | Key Functions |
|--------|----------|---------|---------------|
| **vcm.js** | `/vcm.js` | Main extension entry point | `activate()`, `toggleCurrentFileComments()`, `toggleSplitViewComments()`, `markPrivate()` |
| **parseDocComs.js** | `/src/vcm/utils_copycode/parseDocComs.js` | Extract comments from text | `parseDocComs(text, filePath)` → Returns comment array |
| **injectExtractComments.js** | `/src/helpers_subroutines/injectExtractComments.js` | Add/remove comments | `injectComments()`, `stripComments()` |
| **mergeIntoVCMs.js** | `/src/vcm/helpers_subroutines/mergeIntoVCMs.js` | Reconcile doc ↔ VCM | `mergeIntoVCMs(options)` → Returns updated VCM |
| **createVCMFiles.js** | `/src/vcm/helpers_subroutines/createVCMFiles.js` | Read/write VCM files | `readSharedVCM()`, `writeSharedVCM()`, `readPrivateVCM()`, `writePrivateVCM()` |
| **splitViewManager.js** | `/src/split_view/splitViewManager.js` | Live sync split view | `watchDocument()`, debounced updates |
| **detectModes.js** | `/src/helpers_subroutines/detectModes.js` | Determine clean/commented | `detectInitialMode()`, `detectPrivateVisibility()` |

---

### Utility Modules

| Module | Location | Purpose | Key Functions |
|--------|----------|---------|---------------|
| **buildContextKey.js** | `/src/utils_copycode/buildContextKey.js` | Generate comment identifier | `buildContextKey(comment)` → `"type:anchor:prevHash:nextHash"` |
| **isSameComment.js** | `/src/utils_copycode/isSameComment.js` | Match comments | `isSameComment(c1, c2)` → boolean |
| **findCommentAtCursor.js** | `/src/utils_copycode/findCommentAtCursor.js` | Locate comment under cursor | `findCommentAtCursor(comments, line)` → comment object |
| **getCommentText.js** | `/src/utils_copycode/getCommentText.js` | Extract text from comment | `getCommentText(comment)` → string |
| **commentMarkers.js** | `/src/utils_copycode/commentMarkers.js` | Language-specific markers | `getCommentMarkers(filePath)` → `{line, inline, block}` |
| **lineUtils.js** | `/src/utils_copycode/lineUtils.js` | Line hashing utilities | `hashLine()`, `isolateCodeLine()` |
| **mergeTextCleanMode.js** | `/src/utils_copycode/mergeTextCleanMode.js` | Merge clean mode edits | `mergeSharedTextCleanMode()` |

---

### Helper Functions

| Module | Location | Purpose | Key Functions |
|--------|----------|---------|---------------|
| **generateCommentedVersion.js** | `/src/helpers_subroutines/generateCommentedVersion.js` | Create commented text | `generateCommentedVersion(options)` |
| **alwaysShow.js** | `/src/helpers_subroutines/alwaysShow.js` | AlwaysShow utilities | `isAlwaysShow()`, `hasAlwaysShow()` |
| **readBothVCMs.js** | `/src/vcm/helpers_subroutines/readBothVCMs.js` | Load shared + private | `readBothVCMs()` → `{shared, private}` |

---

## 🔑 Key Data Structures

### Comment Object
```javascript
{
  // Required fields
  type: "inline" | "line" | "block",

  // Text content
  text: "comment text",              // For inline/line
  block: ["line1", "line2", ...],    // For block (array of lines)

  // Anchoring (hash-based positioning)
  anchor: "hash_of_code_line",       // What code does this annotate?
  prevHash: "hash_of_prev_line",     // What's before?
  nextHash: "hash_of_next_line",     // What's after?

  // Metadata
  commentedLineIndex: 42,            // Original line number

  // Optional flags
  isPrivate: true,                   // Stored in private VCM
  alwaysShow: true,                  // Visible in clean mode

  // Clean mode editing
  text_cleanMode: "edited text",     // Edits made in clean mode

  // Private consecutive anchoring
  primaryAnchor: "hash",             // Primary anchor (for consecutive private)
  primaryPrevHash: "hash",           // Primary prev (for consecutive private)
  primaryNextHash: "hash",           // Primary next (for consecutive private)

  // Block-specific
  trailingBlankLines: 2              // Blank lines after header block
}
```

---

### VCM File Format
```json
{
  "file": "src/example.js",
  "lastModified": "2026-01-03T15:30:00.000Z",
  "comments": [
    {
      "type": "inline",
      "text": " // comment text",
      "anchor": "abc123",
      "prevHash": "def456",
      "nextHash": "ghi789",
      "commentedLineIndex": 42,
      "alwaysShow": true
    }
  ]
}
```

---

### Comment Jump Index
```javascript
{
  // O(1) click detection
  lineToComment: Map<lineNum, commentObj>,

  // Find comment by context key
  keyToLines: Map<contextKey, [lineNums]>,

  // Find code line by hash
  anchorToLines: Map<codeHash, [lineNums]>
}
```

**Cache Key:** `${documentUri}:${documentVersion}`

---

## 🧩 Critical Implementation Details

### 1. AlwaysShow Prevention
- Comments with `alwaysShow: true` **never** injected (already physical in file)
- **Never** stripped from document
- Updated **directly** during merges (no `text_cleanMode`)

### 2. text_cleanMode Field
- Stores edits made in clean mode
- Only for **shared, non-alwaysShow** comments
- When switching to commented mode: merged back into main `text`/`block`
- **Cleared** after merge

### 3. isPrivate Flag Semantics
- Private VCM stores `isPrivate: true` (canonical)
- Shared VCM **filters it out** (doesn't store)
- Used during enrichment to determine primary anchors

### 4. Injection Flags (Loop Prevention)
- `justInjectedFromVCM` - Set after toggling modes
- `justInjectedFromPrivateVCM` - Set after toggling private
- Checked in `saveVCM()` - if set, **skip** processing
- Cleared after first save

### 5. VCM Sync Gating
- `vcmSyncEnabled = false` - Disables `saveVCM()` watcher
- Used during toggles to prevent loops
- Re-enabled after operation completes

### 6. Mode Detection Priority
1. Check if VCM exists
2. If no VCM: Parse document → has comments? → commented : clean
3. If VCM exists: Find first toggleable comment → in document? → commented : clean
4. Fallback: clean mode

### 7. Context Key Matching
- Format: `"type:anchor:prevHash:nextHash"`
- Enables O(1) comment lookup
- Survives code refactoring (as long as context unchanged)
- Used for matching during merges

### 8. Best Match Scoring (Duplicates)
```
Score = 0
IF prevHash matches: Score += 10
IF nextHash matches: Score += 10
Tiebreak: Distance from original position (closer = better)
```

### 9. Comment Reconstruction (Undo/Redo)
- VCM files **never deleted**
- Mode re-detected via `detectInitialMode()`
- Private visibility re-detected via `detectPrivateVisibility()`
- Ensures complete recovery on undo

### 10. Save VCM Allowance
- `allowCreate = false` (default): Only update if VCM exists
- `allowCreate = true` (explicit): Create/update VCM
- Prevents auto-creation on unrelated saves

---

## 🎯 Summary

This VCM system creates a sophisticated, context-aware comment management architecture that:

1. **Tracks comments across refactoring** via hash-based anchoring
2. **Separates shared and private** comment storage with independent toggles
3. **Supports multiple modes** (clean/commented) with alwaysShow override
4. **Provides split view navigation** with click-to-jump and live sync
5. **Handles three comment types** (line, inline, block) with type-specific processing
6. **Preserves metadata** (alwaysShow, isPrivate) through merges
7. **Enables clean mode editing** via `text_cleanMode` field
8. **Prevents duplicate processing** via injection flags and sync gating
9. **Caches jump indexes** for O(1) navigation performance
10. **Supports undo/redo** by preserving VCM state

The system uses **two-phase separation** (parse → merge) to maintain flexibility while ensuring data integrity across all operations.
