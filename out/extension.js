"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
let panel;
let watchers = [];
let refreshTimer;
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('showy.openProjectMap', () => {
        openShowyPanel(context);
    }));
}
function deactivate() {
    disposeWatchers();
}
function openShowyPanel(context) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.One);
        return;
    }
    panel = vscode.window.createWebviewPanel('showy', 'Showy Project Map', vscode.ViewColumn.One, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    });
    panel.webview.html = getWebviewContent(panel.webview);
    panel.onDidDispose(() => {
        panel = undefined;
        disposeWatchers();
    }, null, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'ready':
            case 'refresh':
                await refreshTree();
                break;
            case 'nodeSelected':
                await sendNodeStats(message.path);
                break;
        }
    }, null, context.subscriptions);
    refreshTree();
}
async function refreshTree() {
    if (!panel) {
        return;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        panel.webview.postMessage({ type: 'status', text: 'Open a workspace folder to use Showy.' });
        return;
    }
    disposeWatchers();
    const rootNodes = [];
    for (const workspaceFolder of workspaceFolders) {
        const rootNode = await scanFolder(workspaceFolder.uri, workspaceFolder.name);
        rootNodes.push(rootNode);
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, '**/*'));
        watcher.onDidCreate(scheduleRefresh, null);
        watcher.onDidChange(scheduleRefresh, null);
        watcher.onDidDelete(scheduleRefresh, null);
        watchers.push(watcher);
    }
    panel.webview.postMessage({ type: 'treeData', tree: rootNodes });
    panel.webview.postMessage({ type: 'status', text: 'Project tree loaded.' });
}
function scheduleRefresh() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
        refreshTree();
    }, 300);
}
function disposeWatchers() {
    for (const watcher of watchers) {
        watcher.dispose();
    }
    watchers = [];
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
    }
}
async function scanFolder(uri, displayName) {
    const folderNode = {
        id: uri.toString(),
        name: displayName,
        path: uri.fsPath,
        type: 'folder',
        children: [],
        childCount: 0
    };
    try {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        entries.sort((a, b) => {
            if (a[1] === b[1]) {
                return a[0].localeCompare(b[0]);
            }
            return a[1] === vscode.FileType.Directory ? -1 : 1;
        });
        for (const [name, fileType] of entries) {
            const childUri = vscode.Uri.joinPath(uri, name);
            if (fileType === vscode.FileType.Directory) {
                const childNode = await scanFolder(childUri, name);
                folderNode.children?.push(childNode);
            }
            else if (fileType === vscode.FileType.File) {
                const stat = await vscode.workspace.fs.stat(childUri);
                folderNode.children?.push({
                    id: childUri.toString(),
                    name,
                    path: childUri.fsPath,
                    type: 'file',
                    size: stat.size,
                    modifiedAt: stat.mtime
                });
            }
            else {
                folderNode.children?.push({
                    id: childUri.toString(),
                    name,
                    path: childUri.fsPath,
                    type: 'file'
                });
            }
        }
        folderNode.childCount = folderNode.children ? folderNode.children.length : 0;
    }
    catch (error) {
        console.error('Scan folder failed:', error);
    }
    return folderNode;
}
async function sendNodeStats(nodePath) {
    if (!panel) {
        return;
    }
    try {
        const uri = vscode.Uri.file(nodePath);
        const stat = await vscode.workspace.fs.stat(uri);
        const isDirectory = stat.type === vscode.FileType.Directory;
        const stats = {
            path: nodePath,
            type: isDirectory ? 'folder' : 'file',
            size: isDirectory ? undefined : stat.size,
            modifiedAt: stat.mtime,
            createdAt: stat.ctime
        };
        if (isDirectory) {
            try {
                const children = await vscode.workspace.fs.readDirectory(uri);
                stats.childCount = children.length;
            }
            catch {
                stats.childCount = 0;
            }
        }
        panel.webview.postMessage({ type: 'nodeStats', stats });
    }
    catch (error) {
        console.error('Failed to load stats:', error);
        panel.webview.postMessage({ type: 'status', text: 'Unable to load stats for this node.' });
    }
}
function getWebviewContent(webview) {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Showy Project Map</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: Segoe UI, sans-serif;
    }
    body {
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: 1.4fr 0.9fr;
      height: 100vh;
      overflow: hidden;
      gap: 0;
    }
    header {
      padding: 12px 16px;
      background: #1e1e1e;
      color: white;
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header button {
      background: #0e639c;
      border: none;
      color: white;
      padding: 8px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
    }
    #tree-container {
      overflow: auto;
      padding: 16px;
      background: #252526;
      color: #d4d4d4;
    }
    #details {
      padding: 16px;
      border-left: 1px solid rgba(255,255,255,0.08);
      background: #1e1e1e;
      color: #d4d4d4;
      overflow: auto;
    }
    ul.tree {
      list-style: none;
      padding-left: 18px;
      margin: 0;
    }
    li.node {
      margin: 4px 0;
      line-height: 1.5;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    li.node .label {
      cursor: pointer;
      user-select: none;
      padding: 4px 6px;
      border-radius: 4px;
    }
    li.node .label:hover {
      background: rgba(255,255,255,0.08);
    }
    li.node.folder > .label::before {
      content: '▸';
      display: inline-block;
      width: 16px;
      transform: rotate(0deg);
      transition: transform 0.2s ease;
    }
    li.node.expanded > .label::before {
      transform: rotate(90deg);
    }
    li.node.folder > ul {
      display: none;
      margin-left: 14px;
    }
    li.node.expanded > ul {
      display: block;
    }
    .node-meta {
      color: #9cdcfe;
      font-size: 0.9rem;
    }
    #details h2 {
      margin-top: 0;
    }
    #status {
      padding: 0 16px 12px;
      color: #9cdcfe;
      font-size: 0.9rem;
    }
    pre {
      background: rgba(255,255,255,0.04);
      padding: 12px;
      border-radius: 6px;
      overflow: auto;
    }
  </style>
</head>
<body>
  <header>
    <span>Showy Project Map</span>
    <button id="refreshButton">Refresh</button>
  </header>
  <div id="tree-container">
    <div id="status">Loading workspace tree...</div>
    <div id="tree"></div>
  </div>
  <div id="details">
    <h2>Node Details</h2>
    <div id="detailContent">Select a file or folder to see stats.</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const treeRoot = document.getElementById('tree');
    const detailContent = document.getElementById('detailContent');
    const statusBar = document.getElementById('status');
    const refreshButton = document.getElementById('refreshButton');

    refreshButton.addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
      statusBar.textContent = 'Refreshing project tree...';
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'treeData':
          renderTree(message.tree);
          break;
        case 'nodeStats':
          showStats(message.stats);
          break;
        case 'status':
          statusBar.textContent = message.text;
          break;
      }
    });

    vscode.postMessage({ command: 'ready' });

    function renderTree(nodes) {
      treeRoot.innerHTML = '';
      if (!Array.isArray(nodes) || nodes.length === 0) {
        treeRoot.textContent = 'No workspace folders found.';
        return;
      }
      const treeElement = document.createElement('ul');
      treeElement.className = 'tree';
      for (const node of nodes) {
        treeElement.appendChild(createNodeElement(node));
      }
      treeRoot.appendChild(treeElement);
    }

    function createNodeElement(node) {
      const item = document.createElement('li');
      item.className = 'node ' + node.type;

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = node.name;
      label.title = node.path;

      if (node.type === 'folder') {
        const meta = document.createElement('span');
        meta.className = 'node-meta';
        meta.textContent = '(' + (node.childCount ?? 0) + ' items)';
        label.appendChild(meta);
      }

      label.addEventListener('click', () => {
        if (node.type === 'folder') {
          item.classList.toggle('expanded');
        }
        vscode.postMessage({ command: 'nodeSelected', path: node.path });
      });

      item.appendChild(label);

      if (node.children && node.children.length > 0) {
        const childList = document.createElement('ul');
        childList.className = 'tree';
        for (const child of node.children) {
          childList.appendChild(createNodeElement(child));
        }
        item.appendChild(childList);
      }

      return item;
    }

    function showStats(stats) {
      const createdAt = stats.createdAt ? new Date(stats.createdAt).toLocaleString() : 'N/A';
      const modifiedAt = stats.modifiedAt ? new Date(stats.modifiedAt).toLocaleString() : 'N/A';
      let html = '';
      html += '<p><strong>Path:</strong> ' + escapeHtml(stats.path) + '</p>';
      html += '<p><strong>Type:</strong> ' + escapeHtml(stats.type) + '</p>';
      if (stats.size != null) {
        html += '<p><strong>Size:</strong> ' + stats.size + ' bytes</p>';
      }
      html += '<p><strong>Last Modified:</strong> ' + modifiedAt + '</p>';
      html += '<p><strong>Created:</strong> ' + createdAt + '</p>';
      if (stats.childCount != null) {
        html += '<p><strong>Children:</strong> ' + stats.childCount + '</p>';
      }
      html += '<h3>Raw JSON</h3>';
      html += '<pre>' + escapeHtml(JSON.stringify(stats, null, 2)) + '</pre>';
      detailContent.innerHTML = html;
    }

    function escapeHtml(unsafe) {
      return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
}
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=extension.js.map