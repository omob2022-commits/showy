import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { scanFileDependencies, resolveDependencyPath } from './dependencyScanner';
import { buildDependencyGraph, findCircularDependencies, ShowyNode } from './dependencyGraph';

const execAsync = promisify(exec);

type ConfigKey = 'showGitInfo' | 'showDependencies' | 'previewSize' | 'showLineCount';

interface GitInfo {
  lastModified: string;
  commitCount: number;
  author: string;
}

interface DatabaseInfo {
  clients: string[];
  connectionStrings: string[];
  envVariables: string[];
  projectPackages: string[];
}

// Directories to skip during folder scanning
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', '.next', '__pycache__',
  '.cache', 'coverage', '.nyc_output', 'build', '.turbo', '.svelte-kit'
]);

let panel: vscode.WebviewPanel | undefined;
let sidebarView: vscode.WebviewView | undefined;
let watchers: vscode.FileSystemWatcher[] = [];
let refreshTimer: NodeJS.Timeout | undefined;

function getConfig<T>(key: ConfigKey): T | undefined {
  return vscode.workspace.getConfiguration('showy').get<T>(key);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('showy.openProjectMap', () => {
      openShowyPanel(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('showy.openShowySidebar', async () => {
      if (sidebarView) {
        sidebarView.show?.(true);
      } else {
        await vscode.commands.executeCommand('workbench.view.extension.showySidebar');
      }
    })
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('showyView', new ShowySidebarProvider(context))
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

  // Load webview content asynchronously
  getWebviewContent(panel.webview, context.extensionPath).then(html => {
    if (panel) {
      panel.webview.html = html;
    }
  });

  panel.onDidDispose(() => {
    panel = undefined;
    if (!sidebarView) {
      disposeWatchers();
    }
  }, null, context.subscriptions);

  registerWebviewMessageHandlers(panel.webview);
  refreshTree();
}

async function refreshTree() {
  if (!panel && !sidebarView) {
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    postToWebviews({ type: 'status', text: 'Open a workspace folder to use Showy.' });
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

  postToWebviews({ type: 'treeData', tree: rootNodes });
  postToWebviews({ type: 'status', text: 'Project tree loaded.' });

  // Build dependency graph asynchronously (non-blocking)
  if (getConfig<boolean>('showDependencies') !== false && rootNodes.length > 0) {
    try {
      const graph = await buildDependencyGraph(rootNodes[0]);

      const graphData = {
        nodes: Array.from(graph.nodes.values()),
        stats: {
          totalFiles: graph.nodes.size,
          totalDependencies: Array.from(graph.nodes.values()).reduce((sum, node) => sum + node.dependencies.length, 0),
          averageDependenciesPerFile: Array.from(graph.nodes.values()).reduce((sum, node) => sum + node.dependencies.length, 0) / Math.max(graph.nodes.size, 1),
        }
      };

      postToWebviews({ type: 'graphData', graph: graphData });

      // Detect circular dependencies
      const circles = findCircularDependencies(graph);
      if (circles.length > 0) {
        postToWebviews({ type: 'circularDependencies', circles });
        postToWebviews({ 
          type: 'status', 
          text: `⚠️ Found ${circles.length} circular ${circles.length === 1 ? 'dependency' : 'dependencies'}` 
        });
      }
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

function postToWebviews(message: unknown) {
  if (panel) {
    panel.webview.postMessage(message);
  }
  if (sidebarView) {
    sidebarView.webview.postMessage(message);
  }
}

function registerWebviewMessageHandlers(webview: vscode.Webview) {
  webview.onDidReceiveMessage(async (message) => {
    await handleWebviewMessage(message);
  });
}

async function handleWebviewMessage(message: { command: string; path?: string }) {
  switch (message.command) {
    case 'ready':
    case 'refresh':
      await refreshTree();
      break;
    case 'nodeSelected':
      if (message.path) {
        await sendNodeStats(message.path);
      }
      break;
  }
}

class ShowySidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView) {
    sidebarView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };
    
    // Load webview content asynchronously
    getWebviewContent(webviewView.webview, this.context.extensionPath).then(html => {
      if (sidebarView) {
        sidebarView.webview.html = html;
      }
    });
    
    registerWebviewMessageHandlers(webviewView.webview);
    webviewView.onDidDispose(() => {
      sidebarView = undefined;
      if (!panel) {
        disposeWatchers();
      }
    }, null, this.context.subscriptions);
    refreshTree();
  }
}

async function getLineCount(filePath: string): Promise<number> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
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

    // Check if git is available
    try {
      await execAsync('git rev-parse --git-dir', { cwd: repoPath });
    } catch {
      return undefined;
    }

    const relPath = path.relative(repoPath, filePath);

    // Run all three git queries concurrently
    const [timestampResult, countResult, authorResult] = await Promise.allSettled([
      execAsync(`git log -1 --format=%ai -- "${relPath}"`, { cwd: repoPath }),
      execAsync(`git rev-list --count HEAD -- "${relPath}"`, { cwd: repoPath }),
      execAsync(`git log --reverse --format=%an -- "${relPath}"`, { cwd: repoPath }),
    ]);

    let lastModified = 'N/A';
    if (timestampResult.status === 'fulfilled') {
      const ts = timestampResult.value.stdout.trim();
      if (ts) {
        lastModified = new Date(ts).toLocaleString();
      }
    }

    let commitCount = 0;
    if (countResult.status === 'fulfilled') {
      commitCount = parseInt(countResult.value.stdout.trim()) || 0;
    }

    let author = 'Unknown';
    if (authorResult.status === 'fulfilled') {
      const lines = authorResult.value.stdout.trim().split('\n');
      author = lines[0] || 'Unknown';
    }

    return { lastModified, commitCount, author };
  } catch (error) {
    console.error(`Failed to get git info for ${filePath}:`, error);
    return undefined;
  }
}

/**
 * Detects binary content by checking for null bytes in the first 8KB.
 */
function looksLikeBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

async function getFilePreview(filePath: string, maxChars: number = 500): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);

    // Skip files larger than 1MB
    if (stat.size > 1024 * 1024) {
      return undefined;
    }

    // Read a small buffer first to check for binary content
    const fd = await fs.promises.open(filePath, 'r');
    const headerBuf = Buffer.alloc(Math.min(stat.size, 8192));
    await fd.read(headerBuf, 0, headerBuf.length, 0);
    await fd.close();

    if (looksLikeBinary(headerBuf)) {
      return undefined;
    }

    const content = await fs.promises.readFile(filePath, 'utf-8');
    const preview = content.substring(0, maxChars);
    return content.length > maxChars ? preview + '...' : preview;
  } catch {
    return undefined;
  }
}

const DATABASE_MODULES = new Set([
  'pg', 'pg-native', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis',
  'sequelize', 'typeorm', 'knex', 'sqlite3', 'better-sqlite3', 'tedious', 'mssql',
  'oracledb', 'prisma', '@prisma/client', 'cockroachdb', 'neo4j-driver', 'cassandra-driver'
]);

async function scanFileDatabaseDependencies(filePath: string): Promise<DatabaseInfo> {
  const result: DatabaseInfo = {
    clients: [],
    connectionStrings: [],
    envVariables: [],
    projectPackages: []
  };

  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const importRegex = /(?:import\s+[\s\S]+?from\s+['"]([^'"]+)['"])|(?:require\(['"]([^'"]+)['"]\))/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const candidate = match[1] || match[2];
      if (candidate) {
        const base = candidate.split('/')[0];
        if (DATABASE_MODULES.has(base) && !result.clients.includes(base)) {
          result.clients.push(base);
        }
      }
    }

    const configRegex = /(?:connectionString|connString|dsn|databaseUrl|DATABASE_URL|DB_CONNECTION|DB_HOST|DB_USER|DB_NAME|DB_PASSWORD|DB_PASS|MONGO_URI|MONGODB_URI)/gi;
    let found;
    while ((found = configRegex.exec(content)) !== null) {
      const token = found[0];
      if (token.toUpperCase().endsWith('_URL') || token.toUpperCase().endsWith('_URI') || token.toUpperCase().includes('CONNECTION')) {
        if (!result.connectionStrings.includes(token)) {
          result.connectionStrings.push(token);
        }
      } else if (!result.envVariables.includes(token)) {
        result.envVariables.push(token);
      }
    }

    const connStringRegex = /(postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis:\/\/|mssql:\/\/|sqlite:\/\/|oracle:\/\/)/gi;
    const connStringMatch = content.match(connStringRegex);
    if (connStringMatch) {
      for (const entry of connStringMatch) {
        if (!result.connectionStrings.includes(entry)) {
          result.connectionStrings.push(entry);
        }
      }
    }
  } catch {
    // ignore unreadable files
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
  if (workspaceFolder) {
    result.projectPackages = await scanWorkspaceDatabasePackages(workspaceFolder.uri.fsPath);
  }

  return result;
}

async function scanWorkspaceDatabasePackages(rootPath: string): Promise<string[]> {
  const detected: string[] = [];
  try {
    const packageJsonPath = path.join(rootPath, 'package.json');
    if (await fs.promises.stat(packageJsonPath)) {
      const content = await fs.promises.readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const dep of Object.keys(allDeps)) {
        const base = dep.split('/')[0];
        if (DATABASE_MODULES.has(base) && !detected.includes(base)) {
          detected.push(base);
        }
      }
    }
  } catch {
    // ignore missing package.json or parse errors
  }
  return detected;
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
      // Skip noisy/irrelevant directories
      if (fileType === vscode.FileType.Directory && EXCLUDED_DIRS.has(name)) {
        continue;
      }

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
      if (getConfig<boolean>('showLineCount') !== false) {
        const lineCount = await getLineCount(nodePath);
        if (lineCount > 0) {
          stats.lineCount = lineCount;
        }
      }

        if (getConfig<boolean>('showGitInfo') !== false) {
        const gitInfo = await getGitInfo(nodePath);
        if (gitInfo) {
          stats.gitInfo = gitInfo;
        }
      }

      const databaseInfo = await scanFileDatabaseDependencies(nodePath);
      if (databaseInfo.clients.length > 0 || databaseInfo.connectionStrings.length > 0 || databaseInfo.envVariables.length > 0 || databaseInfo.projectPackages.length > 0) {
        stats.databaseInfo = databaseInfo;
      }

      const previewSize = getConfig<number>('previewSize') ?? 500;
      const preview = await getFilePreview(nodePath, previewSize);
      if (preview) {
        stats.preview = preview;
      }

      if (getConfig<boolean>('showDependencies') !== false) {
        try {
          const dependencies = await scanFileDependencies(nodePath);
          if (dependencies.length > 0) {
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

    // Post to both panel and sidebar
    postToWebviews({ type: 'nodeStats', stats });
  } catch (error) {
    console.error('Failed to load stats:', error);
    postToWebviews({ type: 'status', text: 'Unable to load stats for this node.' });
  }
}

async function getWebviewContent(webview: vscode.Webview, extensionPath: string): Promise<string> {
  const nonce = getNonce();
  const htmlPath = path.join(extensionPath, 'media', 'webview.html');

  let html = await fs.promises.readFile(htmlPath, 'utf-8');

  // Replace template placeholders
  html = html.replace(/\{\{nonce\}\}/g, nonce);
  html = html.replace(/\{\{cspSource\}\}/g, webview.cspSource);

  return html;
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
