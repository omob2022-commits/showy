# Showy 🌳

**Showy** is a VS Code extension that visualizes your workspace as an interactive tree and dependency graph. Navigate your codebase visually, understand file relationships, and detect circular dependencies at a glance.

## Features

### 📁 Interactive Tree View
- Expandable/collapsible folder structure
- Real-time file system watching with auto-refresh
- Click any file or folder to see detailed stats
- Smart filtering (excludes `node_modules`, `.git`, `dist`, etc.)

### 🕸️ Dependency Graph
- Visual force-directed graph powered by D3.js
- Color-coded nodes:
  - 🔵 **Blue**: No dependencies
  - 🟡 **Yellow**: Some dependencies (1-5)
  - 🔴 **Red**: Many dependencies (>5)
- Interactive: drag nodes, click to see details
- Legend included for easy interpretation

### ⚠️ Circular Dependency Detection
- Automatically detects circular imports
- Highlights affected files in the details panel
- Shows the complete dependency cycle path

### 📊 File Details Panel
- **File Stats**: Size, line count, modified/created dates
- **Git Info**: Commit count, original author, last modified
- **Dependencies**: Import/require statements with resolved paths
- **Preview**: First 500 characters of file content
- **Circular Dependencies**: Warning if file is part of a cycle

### 🎯 Language Support
- **JavaScript/TypeScript**: ES6 imports, CommonJS requires, type imports, side-effect imports
- **Python**: import statements, from...import, package detection
- **C/C++**: #include directives

## Installation

### From Source
1. Clone this repository
2. Run `npm install`
3. Run `npm run compile`
4. Press `F5` to launch in Extension Development Host

### From Marketplace
*(Coming soon)*

## Usage

### Open Project Map
- **Command Palette**: `Showy: Open Project Map`
- **Editor Title Bar**: Click the graph icon (when a file is open)

### Open Sidebar
- **Command Palette**: `Showy: Reveal Sidebar`
- **Activity Bar**: Click the Showy icon

### Switch Views
- Click **Tree** or **Graph** buttons in the header
- Tree view shows hierarchical file structure
- Graph view shows dependency relationships

### Interact with Files
- **Tree View**: Click folder names to expand/collapse, click files to see details
- **Graph View**: Drag nodes to rearrange, click nodes to see details
- **Details Panel**: Always shows stats for the selected file/folder

## Configuration

Configure Showy via VS Code settings (`Preferences: Open Settings (JSON)`):

```json
{
  "showy.showGitInfo": true,          // Show git commit info
  "showy.showDependencies": true,     // Scan and show dependencies
  "showy.showLineCount": true,        // Calculate line counts
  "showy.previewSize": 500            // Max characters in preview
}
```

## Performance

- **Fully async**: No blocking I/O operations
- **Parallel scanning**: Dependencies scanned concurrently
- **Smart caching**: 5-minute TTL on dependency scans
- **Efficient algorithms**: O(1) lookups with Set-based data structures

## Requirements

- VS Code 1.118.0 or higher
- Git (optional, for git info features)

## Known Limitations

- External dependencies (npm packages, system libraries) are shown as "external / unresolved"
- Git info requires the workspace to be a git repository
- Very large files (>1MB) are excluded from preview

## Development

### Project Structure
```
showy/
├── src/
│   ├── extension.ts          # Main extension logic
│   ├── dependencyGraph.ts    # Graph algorithms
│   └── dependencyScanner.ts  # Dependency parsing
├── media/
│   └── webview.html          # UI template
└── package.json              # Extension manifest
```

### Build Commands
- `npm run compile` - Compile TypeScript
- `npm run watch` - Watch mode for development

### Testing
Press `F5` in VS Code to launch the Extension Development Host with the extension loaded.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.
