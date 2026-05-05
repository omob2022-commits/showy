import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { scanFileDependencies, resolveDependencyPath } from './dependencyScanner';
import { buildDependencyGraph } from './dependencyGraph';

type NodeType = 'folder' | 'file';

interface GitInfo {
  lastModified: string;
  commitCount: number;
  author: string;
}

interface ShowyNode {
  id: string;
  name: string;
  path: string;
  type: NodeType;
  size?: number;
  modifiedAt?: number;
  childCount?: number;
  children?: ShowyNode[];
  lineCount?: number;
  gitInfo?: GitInfo;
  preview?: string;
  dependencies?: string[];
}

let panel: vscode.WebviewPanel | undefined;
let watchers: vscode.FileSystemWatcher[] = [];
let refreshTimer: NodeJS.Timeout | undefined;

// Helper to get configuration values
function getConfig(key: string): any {
  return vscode.workspace.getConfiguration('showy').get(key);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('showy.openProjectMap', () => {
      openShowyPanel(context);
    })
  );
}

export function deactivate() {
  disposeWatchers();
}

function openShowyPanel(context: vscode.ExtensionContext) {
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

  const rootNodes: ShowyNode[] = [];
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

  // Build dependency graph asynchronously (non-blocking)
  if (getConfig('showDependencies') !== false && rootNodes.length > 0) {
    try {
      const graph = await buildDependencyGraph(rootNodes[0]);
      
      // Convert Map to serializable format for webview
      const graphData = {
        nodes: Array.from(graph.nodes.values()),
        stats: {
          totalFiles: graph.nodes.size,
          totalDependencies: Array.from(graph.nodes.values()).reduce((sum, node) => sum + node.dependencies.length, 0),
          averageDependenciesPerFile: Array.from(graph.nodes.values()).reduce((sum, node) => sum + node.dependencies.length, 0) / Math.max(graph.nodes.size, 1),
        }
      };
      
      panel.webview.postMessage({ type: 'graphData', graph: graphData });
    } catch (error) {
      console.error('Failed to build dependency graph:', error);
    }
  }
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

async function getLineCount(filePath: string): Promise<number> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

async function getGitInfo(filePath: string): Promise<GitInfo | undefined> {
  try {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!workspaceFolder) {
      return undefined;
    }

    const repoPath = workspaceFolder.uri.fsPath;
    
    // Check if git is available by trying a simple git command
    try {
      execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
    } catch {
      return undefined;
    }

    // Get relative path from repo root
    const relPath = path.relative(repoPath, filePath);

    // Get last commit timestamp
    let lastModified = 'N/A';
    try {
      const timestamp = execSync(`git log -1 --format=%ai -- "${relPath}"`, {
        cwd: repoPath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      if (timestamp) {
        lastModified = new Date(timestamp).toLocaleString();
      }
    } catch {
      // Ignore errors
    }

    // Get commit count
    let commitCount = 0;
    try {
      const count = execSync(`git rev-list --count HEAD -- "${relPath}"`, {
        cwd: repoPath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      commitCount = parseInt(count) || 0;
    } catch {
      // Ignore errors
    }

    // Get original author
    let author = 'Unknown';
    try {
      author = execSync(`git log --reverse --format=%an -- "${relPath}" | head -1`, {
        cwd: repoPath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 3000,
      }).trim() || 'Unknown';
    } catch {
      // Ignore errors
    }

    return { lastModified, commitCount, author };
  } catch (error) {
    console.error(`Failed to get git info for ${filePath}:`, error);
    return undefined;
  }
}

async function getFilePreview(filePath: string, maxChars: number = 500): Promise<string | undefined> {
  try {
    const stat = fs.statSync(filePath);
    
    // Only preview text files with reasonable size
    if (stat.size > 1024 * 1024) {
      // Skip files larger than 1MB
      return undefined;
    }

    // Check if it looks like a text file based on extension
    const ext = path.extname(filePath).toLowerCase();
    const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bin', '.exe', '.dll', '.so'];
    if (binaryExtensions.includes(ext)) {
      return undefined;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const preview = content.substring(0, maxChars);
    
    if (content.length > maxChars) {
      return preview + '...';
    }
    return preview;
  } catch {
    return undefined;
  }
}

async function scanFolder(uri: vscode.Uri, displayName: string): Promise<ShowyNode> {
  const folderNode: ShowyNode = {
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
      } else if (fileType === vscode.FileType.File) {
        const stat = await vscode.workspace.fs.stat(childUri);
        folderNode.children?.push({
          id: childUri.toString(),
          name,
          path: childUri.fsPath,
          type: 'file',
          size: stat.size,
          modifiedAt: stat.mtime
        });
      } else {
        folderNode.children?.push({
          id: childUri.toString(),
          name,
          path: childUri.fsPath,
          type: 'file'
        });
      }
    }

    folderNode.childCount = folderNode.children ? folderNode.children.length : 0;
  } catch (error) {
    console.error('Scan folder failed:', error);
  }

  return folderNode;
}

async function sendNodeStats(nodePath: string) {
  if (!panel) {
    return;
  }

  try {
    const uri = vscode.Uri.file(nodePath);
    const stat = await vscode.workspace.fs.stat(uri);
    const isDirectory = stat.type === vscode.FileType.Directory;
    const stats: Record<string, unknown> = {
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
      } catch {
        stats.childCount = 0;
      }
    } else {
      // For files, gather enhanced stats based on configuration
      
      // Get line count if enabled
      if (getConfig('showLineCount') !== false) {
        const lineCount = await getLineCount(nodePath);
        if (lineCount > 0) {
          stats.lineCount = lineCount;
        }
      }

      // Get git information if enabled
      if (getConfig('showGitInfo') !== false) {
        const gitInfo = await getGitInfo(nodePath);
        if (gitInfo) {
          stats.gitInfo = gitInfo;
        }
      }

      // Get file preview
      const previewSize = getConfig('previewSize') ?? 500;
      const preview = await getFilePreview(nodePath, previewSize);
      if (preview) {
        stats.preview = preview;
      }

      // Get dependencies if enabled
      if (getConfig('showDependencies') !== false) {
        try {
          const dependencies = await scanFileDependencies(nodePath);
          if (dependencies.length > 0) {
            // Try to resolve dependencies to actual file paths
            const resolvedDeps: Record<string, string | null> = {};
            for (const dep of dependencies) {
              const resolved = await resolveDependencyPath(dep, nodePath);
              resolvedDeps[dep] = resolved;
            }
            stats.dependencies = resolvedDeps;
          }
        } catch (error) {
          console.error(`Failed to scan dependencies for ${nodePath}:`, error);
        }
      }
    }

    panel.webview.postMessage({ type: 'nodeStats', stats });
  } catch (error) {
    console.error('Failed to load stats:', error);
    panel.webview.postMessage({ type: 'status', text: 'Unable to load stats for this node.' });
  }
}

function getWebviewContent(webview: vscode.Webview) {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}' https://d3js.org https://cdn.jsdelivr.net; style-src 'nonce-${nonce}'; connect-src https:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Showy Project Map</title>
  <script nonce="${nonce}" src="https://d3js.org/d3.v7.min.js"></script>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: Segoe UI, sans-serif;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-rows: auto 1fr;
      grid-template-columns: 1fr 1fr 0.8fr;
      height: 100vh;
      overflow: hidden;
      gap: 0;
    }
    header {
      grid-column: 1 / -1;
      padding: 12px 16px;
      background: #1e1e1e;
      color: white;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    header h1 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }
    header button {
      background: #0e639c;
      border: none;
      color: white;
      padding: 6px 12px;
      border-radius: 3px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      flex-shrink: 0;
    }
    header button:hover {
      background: #1177bb;
    }
    .view-tabs {
      display: flex;
      gap: 4px;
      margin-left: auto;
      flex-shrink: 0;
    }
    .view-tabs button {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.2);
      color: #d4d4d4;
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
      border-radius: 2px;
    }
    .view-tabs button.active {
      background: #0e639c;
      border-color: #0e639c;
      color: white;
    }
    #tree-container {
      overflow: auto;
      padding: 16px;
      background: #252526;
      color: #d4d4d4;
      display: none;
    }
    #tree-container.active {
      display: block;
    }
    #graph-container {
      background: #252526;
      display: none;
      position: relative;
      overflow: hidden;
    }
    #graph-container.active {
      display: block;
    }
    #graph-svg {
      width: 100%;
      height: 100%;
    }
    .node {
      cursor: pointer;
      stroke: rgba(255,255,255,0.2);
      stroke-width: 1.5px;
    }
    .node:hover {
      stroke: rgba(255,255,255,0.8);
      stroke-width: 2px;
    }
    .link {
      stroke: rgba(100,150,200,0.4);
      stroke-width: 1px;
    }
    .node-label {
      font-size: 11px;
      fill: #d4d4d4;
      text-anchor: middle;
      pointer-events: none;
      user-select: none;
    }
    #details {
      padding: 16px;
      border-left: 1px solid rgba(255,255,255,0.08);
      background: #1e1e1e;
      color: #d4d4d4;
      overflow: auto;
    }
    #details h2 {
      margin-top: 0;
      font-size: 14px;
    }
    #details h3 {
      font-size: 12px;
      margin: 12px 0 6px 0;
      color: #9cdcfe;
    }
    #details p {
      font-size: 12px;
      margin: 4px 0;
      word-break: break-all;
    }
    #status {
      padding: 8px 16px;
      color: #9cdcfe;
      font-size: 11px;
      background: rgba(0,0,0,0.3);
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
      font-size: 12px;
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
    pre {
      background: rgba(255,255,255,0.04);
      padding: 8px;
      border-radius: 4px;
      overflow: auto;
      font-size: 11px;
      margin: 0;
    }
  </style>
</head>
<body>
  <header>
    <h1>🌳 Showy Project Map</h1>
    <div class="view-tabs">
      <button id="treeViewBtn" class="active">Tree</button>
      <button id="graphViewBtn">Graph</button>
    </div>
    <button id="refreshButton">Refresh</button>
  </header>
  <div id="tree-container" class="active">
    <div id="status">Loading workspace tree...</div>
    <div id="tree"></div>
  </div>
  <div id="graph-container">
    <svg id="graph-svg"></svg>
  </div>
  <div id="details">
    <h2>Details</h2>
    <div id="detailContent">Select a file or node to see details.</div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const treeRoot = document.getElementById('tree');
    const graphContainer = document.getElementById('graph-container');
    const detailContent = document.getElementById('detailContent');
    const statusBar = document.getElementById('status');
    const refreshButton = document.getElementById('refreshButton');
    const treeViewBtn = document.getElementById('treeViewBtn');
    const graphViewBtn = document.getElementById('graphViewBtn');
    const treeContainer = document.getElementById('tree-container');
    
    let currentGraphData = null;
    let d3Available = typeof d3 !== 'undefined';

    treeViewBtn.addEventListener('click', () => {
      treeContainer.classList.add('active');
      graphContainer.classList.remove('active');
      treeViewBtn.classList.add('active');
      graphViewBtn.classList.remove('active');
    });

    graphViewBtn.addEventListener('click', () => {
      if (!currentGraphData) {
        alert('Graph data not yet loaded. Please wait for tree to load.');
        return;
      }
      treeContainer.classList.remove('active');
      graphContainer.classList.add('active');
      treeViewBtn.classList.remove('active');
      graphViewBtn.classList.add('active');
      renderGraph();
    });

    refreshButton.addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
      statusBar.textContent = 'Refreshing project tree...';
      currentGraphData = null;
      graphContainer.innerHTML = '<svg id="graph-svg"></svg>';
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'treeData':
          renderTree(message.tree);
          break;
        case 'graphData':
          currentGraphData = message.graph;
          statusBar.textContent = 'Graph loaded: ' + currentGraphData.stats.totalFiles + ' files, ' + currentGraphData.stats.totalDependencies + ' dependencies.';
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

    function renderGraph() {
      if (!currentGraphData || !d3Available) {
        detailContent.innerHTML = '<p>Graph data not available or D3.js not loaded.</p>';
        return;
      }

      const container = document.getElementById('graph-svg');
      const width = graphContainer.clientWidth;
      const height = graphContainer.clientHeight;

      // Clear previous content
      d3.select(container).selectAll('*').remove();

      // Build D3 nodes and links
      const nodes = currentGraphData.nodes.map((n, i) => ({
        id: n.id,
        path: n.path,
        label: n.path.split('/').pop() || n.path,
        index: i
      }));

      const links = [];
      for (const node of currentGraphData.nodes) {
        for (const depPath of node.dependencies) {
          const targetNode = nodes.find(n => n.path === depPath);
          if (targetNode) {
            links.push({
              source: node.id,
              target: targetNode.id,
              sourceNode: node,
              targetNode: targetNode
            });
          }
        }
      }

      // Create SVG
      const svg = d3.select(container)
        .attr('width', width)
        .attr('height', height)
        .attr('style', 'background: #252526;');

      // Create force simulation
      const simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links)
          .id(d => d.id)
          .distance(80)
          .strength(0.3))
        .force('charge', d3.forceManyBody().strength(-200))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collide', d3.forceCollide(30));

      // Draw links
      const link = svg.append('g')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('class', 'link')
        .attr('stroke', 'rgba(100,150,200,0.3)')
        .attr('stroke-width', 1);

      // Draw nodes
      const node = svg.append('g')
        .selectAll('circle')
        .data(nodes)
        .join('circle')
        .attr('class', 'node')
        .attr('r', 8)
        .attr('fill', d => {
          const depCount = currentGraphData.nodes.find(n => n.id === d.id).dependencies.length;
          if (depCount === 0) return '#6a9fb5';
          if (depCount > 5) return '#d94949';
          return '#b8a538';
        })
        .call(drag(simulation));

      // Draw labels
      const label = svg.append('g')
        .selectAll('text')
        .data(nodes)
        .join('text')
        .attr('class', 'node-label')
        .attr('font-size', '10px')
        .text(d => d.label)
        .call(drag(simulation));

      node.on('click', (event, d) => {
        const nodeData = currentGraphData.nodes.find(n => n.id === d.id);
        if (nodeData) {
          vscode.postMessage({ command: 'nodeSelected', path: nodeData.path });
        }
      });

      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);

        node
          .attr('cx', d => d.x)
          .attr('cy', d => d.y);

        label
          .attr('x', d => d.x)
          .attr('y', d => d.y - 12);
      });

      function drag(simulation) {
        function dragstarted(event, d) {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        }

        function dragged(event, d) {
          d.fx = event.x;
          d.fy = event.y;
        }

        function dragended(event, d) {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        }

        return d3.drag()
          .on('start', dragstarted)
          .on('drag', dragged)
          .on('end', dragended);
      }
    }

    function showStats(stats) {
      const createdAt = stats.createdAt ? new Date(stats.createdAt).toLocaleString() : 'N/A';
      const modifiedAt = stats.modifiedAt ? new Date(stats.modifiedAt).toLocaleString() : 'N/A';
      let html = '<div>';
      html += '<p><strong>Path:</strong> ' + escapeHtml(stats.path) + '</p>';
      html += '<p><strong>Type:</strong> ' + escapeHtml(stats.type) + '</p>';
      
      if (stats.size != null) {
        html += '<p><strong>Size:</strong> ' + formatBytes(stats.size) + '</p>';
      }
      
      if (stats.lineCount != null && stats.lineCount > 0) {
        html += '<p><strong>Lines:</strong> ' + stats.lineCount + '</p>';
      }
      
      html += '<p><strong>Modified:</strong> ' + modifiedAt + '</p>';
      html += '<p><strong>Created:</strong> ' + createdAt + '</p>';
      
      if (stats.childCount != null) {
        html += '<p><strong>Children:</strong> ' + stats.childCount + '</p>';
      }

      if (stats.gitInfo) {
        html += '<h3>Git Info</h3>';
        html += '<p><strong>Author:</strong> ' + escapeHtml(stats.gitInfo.author) + '</p>';
        html += '<p><strong>Commits:</strong> ' + stats.gitInfo.commitCount + '</p>';
        html += '<p><strong>Last Modified:</strong> ' + escapeHtml(stats.gitInfo.lastModified) + '</p>';
      }

      if (stats.dependencies && Object.keys(stats.dependencies).length > 0) {
        html += '<h3>Dependencies (' + Object.keys(stats.dependencies).length + ')</h3>';
        html += '<pre>' + escapeHtml(JSON.stringify(stats.dependencies, null, 2)) + '</pre>';
      }

      if (stats.preview) {
        html += '<h3>Preview</h3>';
        html += '<pre>' + escapeHtml(stats.preview) + '</pre>';
      }

      html += '</div>';
      detailContent.innerHTML = html;
    }

    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
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
