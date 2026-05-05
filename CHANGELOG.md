# Changelog

All notable changes to the "Showy" extension will be documented in this file.

## [0.1.0] - 2026-05-06

### Added
- Interactive project tree visualization with file/folder navigation
- Dependency graph view with D3.js force-directed layout
- Circular dependency detection with visual warnings
- Git information display (commit count, author, last modified)
- File preview in details panel
- Line count statistics
- Support for JavaScript/TypeScript, Python, and C++ dependency scanning
- Configurable features via VS Code settings
- Dual view support (panel and sidebar)
- Real-time file system watching with auto-refresh

### Features
- **Tree View**: Expandable/collapsible folder structure
- **Graph View**: Visual dependency relationships with color-coded nodes
  - Blue: No dependencies
  - Yellow: Some dependencies (1-5)
  - Red: Many dependencies (>5)
- **Details Panel**: Shows file stats, git info, dependencies, and preview
- **Circular Dependency Detection**: Automatically detects and highlights circular imports
- **Smart Scanning**: Excludes common directories (node_modules, .git, dist, etc.)

### Technical
- Fully async I/O operations (no blocking calls)
- Parallel dependency scanning for performance
- Efficient O(1) lookups with Set-based algorithms
- Type-safe codebase with exported interfaces
- XSS-safe webview rendering with DOM API
- Binary file detection via null-byte scanning

### Configuration
- `showy.showGitInfo`: Enable/disable git information (default: true)
- `showy.showDependencies`: Enable/disable dependency scanning (default: true)
- `showy.showLineCount`: Enable/disable line count display (default: true)
- `showy.previewSize`: Maximum characters in file preview (default: 500)
