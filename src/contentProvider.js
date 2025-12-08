const vscode = require("vscode");

// Content Provider (provides the files text content) for generating and dynamically updating the split view VCM_filename.type. like a server
// This allows us to display *virtual* documents in VS Code (temp/non stored files)
class VCMContentProvider {
  // function for a class specifically used to initialize the properties of an object
  constructor() {
    // this.content is creating a custom property which creates a Map of URI (temp VCM_) -> document content, which is..
    // Key → the document’s unique URI (e.g., vcm-view:/some/file)
    // Value → the actual string content of that “document.”
    // It’s an in-memory store for what each virtual document currently displays.
    // When placing Map in constructor(), it’s like saying:
    // “Each time I make a new VCMContentProvider (view), give it a clean whiteboard.”
    this.content = new Map(); 
    // Creates a new event emitter from the VS Code API.
    // This object can “fire” events that tell VS Code something changed.
    // Think of it as a signal: “Hey editor, refresh this content.”
    this._onDidChange = new vscode.EventEmitter();
    // Exposes a read-only event property so VS Code (VCM_) can subscribe to changes.
    // When fire() is called later, anything listening to onDidChange reacts — usually VS Code re-requests the document’s content.
    this.onDidChange = this._onDidChange.event;
  }

  // response handler method called by VS Code when it needs to display text to a vcm-view (uri): document
  provideTextDocumentContent(uri) {
    // In the Map, look up the uri and return the content string else empty string
    return this.content.get(uri.toString()) || "";
  }

  // server push that forces update of vcm-view's (uri's) content
  update(uri, content) {
    // update the vcm_ (content's Map) for the specific file view (uri) with the new content
    this.content.set(uri.toString(), content);
    // immediately fire the event telling VS Code the document changed.
    // VS Code hears the event → re-calls provideTextDocumentContent() → updates the editor display.
    this._onDidChange.fire(uri);
  }
}

module.exports = {
  VCMContentProvider,
};
