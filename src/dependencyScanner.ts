import * as fs from 'fs';
import * as path from 'path';

interface DependencyCache {
  timestamp: number;
  dependencies: string[];
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const dependencyCache = new Map<string, DependencyCache>();

// Language-specific regex patterns for detecting dependencies
const PATTERNS = {
  javascript: {
    // Matches: import X from 'path' or import X from "path"
    es6Import: /import\s+(?:{[^}]*}|[^'"]+)\s+from\s+['"]([^'"]+)['"]/g,
    // Matches: require('path') or require("path")
    commonjs: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  },
  python: {
    // Matches: import module or from module import
    import: /^(?:from\s+([^\s.]+)|import\s+([^\s,]+))/gm,
  },
  cpp: {
    // Matches: #include "path/file.h" or #include <path/file.h>
    include: /#include\s+[<"]([^>"]+)[>"]/g,
  },
};

/**
 * Detects the language of a file based on its extension
 */
function detectLanguage(filePath: string): keyof typeof PATTERNS | null {
  const ext = path.extname(filePath).toLowerCase();
  
  if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    return 'javascript';
  } else if (['.py', '.pyw'].includes(ext)) {
    return 'python';
  } else if (['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'].includes(ext)) {
    return 'cpp';
  }
  
  return null;
}

/**
 * Reads a file and extracts dependency paths based on language
 */
export async function scanFileDependencies(filePath: string): Promise<string[]> {
  try {
    // Check cache first
    const cached = dependencyCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.dependencies;
    }

    const language = detectLanguage(filePath);
    if (!language) {
      return [];
    }

    // Read file with size limit (only read first 100KB to avoid performance issues)
    const stat = fs.statSync(filePath);
    const maxSize = 100 * 1024;
    const bytesToRead = Math.min(stat.size, maxSize);
    
    const content = fs.readFileSync(filePath, 'utf-8').substring(0, bytesToRead);
    const dependencies = extractDependencies(content, language, filePath);

    // Cache the result
    dependencyCache.set(filePath, {
      timestamp: Date.now(),
      dependencies,
    });

    return dependencies;
  } catch (error) {
    console.error(`Failed to scan dependencies for ${filePath}:`, error);
    return [];
  }
}

/**
 * Extracts raw dependency strings from file content
 */
function extractDependencies(
  content: string,
  language: keyof typeof PATTERNS,
  filePath: string
): string[] {
  const dependencies = new Set<string>();

  if (language === 'javascript') {
    // Extract ES6 imports
    let match;
    const es6Pattern = PATTERNS.javascript.es6Import;
    while ((match = es6Pattern.exec(content)) !== null) {
      dependencies.add(match[1]);
    }

    // Extract CommonJS requires
    const commonjsPattern = PATTERNS.javascript.commonjs;
    while ((match = commonjsPattern.exec(content)) !== null) {
      dependencies.add(match[1]);
    }
  } else if (language === 'python') {
    let match;
    const importPattern = PATTERNS.python.import;
    while ((match = importPattern.exec(content)) !== null) {
      const moduleName = match[1] || match[2];
      if (moduleName) {
        dependencies.add(moduleName.split('.')[0]); // Top-level module only
      }
    }
  } else if (language === 'cpp') {
    let match;
    const includePattern = PATTERNS.cpp.include;
    while ((match = includePattern.exec(content)) !== null) {
      dependencies.add(match[1]);
    }
  }

  return Array.from(dependencies);
}

/**
 * Attempts to resolve a dependency string to an actual file path
 * Returns null if the dependency cannot be resolved
 */
export async function resolveDependencyPath(
  dependency: string,
  fromFile: string
): Promise<string | null> {
  const fromDir = path.dirname(fromFile);
  const language = detectLanguage(fromFile);

  if (!language) {
    return null;
  }

  try {
    if (language === 'javascript') {
      return resolveJavaScriptDependency(dependency, fromDir);
    } else if (language === 'python') {
      return resolvePythonDependency(dependency, fromDir);
    } else if (language === 'cpp') {
      return resolveCppDependency(dependency, fromDir);
    }
  } catch (error) {
    console.error(`Failed to resolve dependency "${dependency}" from ${fromFile}:`, error);
  }

  return null;
}

/**
 * Resolves a JavaScript/TypeScript import path
 */
function resolveJavaScriptDependency(dependency: string, fromDir: string): string | null {
  // Handle relative imports
  if (dependency.startsWith('.')) {
    const resolvedPath = path.join(fromDir, dependency);
    
    // Try with various extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', ''];
    for (const ext of extensions) {
      const filePath = ext ? resolvedPath + ext : resolvedPath;
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          // Check for index file
          for (const indexExt of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
            const indexPath = path.join(filePath, `index${indexExt}`);
            if (fs.existsSync(indexPath)) {
              return indexPath;
            }
          }
        } else {
          return filePath;
        }
      }
    }
  }
  
  // For node_modules, we just return the dependency name (can't easily resolve all)
  return null;
}

/**
 * Resolves a Python import path
 */
function resolvePythonDependency(dependency: string, fromDir: string): string | null {
  // Try relative import from same directory
  const pyFile = path.join(fromDir, `${dependency}.py`);
  if (fs.existsSync(pyFile)) {
    return pyFile;
  }

  // Try as a package (directory with __init__.py)
  const pkgDir = path.join(fromDir, dependency);
  if (fs.existsSync(pkgDir)) {
    const initFile = path.join(pkgDir, '__init__.py');
    if (fs.existsSync(initFile)) {
      return initFile;
    }
  }

  return null;
}

/**
 * Resolves a C++ include path
 */
function resolveCppDependency(dependency: string, fromDir: string): string | null {
  // Try as relative path from current file's directory
  const resolvedPath = path.join(fromDir, dependency);
  
  if (fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }

  // Try with .h or .hpp extensions if not already present
  if (!dependency.endsWith('.h') && !dependency.endsWith('.hpp')) {
    for (const ext of ['.h', '.hpp']) {
      const withExt = resolvedPath + ext;
      if (fs.existsSync(withExt)) {
        return withExt;
      }
    }
  }

  return null;
}

/**
 * Clears the dependency cache (useful for testing or manual refresh)
 */
export function clearDependencyCache(): void {
  dependencyCache.clear();
}

/**
 * Gets cache statistics (for debugging)
 */
export function getCacheStats(): { size: number; entries: string[] } {
  return {
    size: dependencyCache.size,
    entries: Array.from(dependencyCache.keys()),
  };
}
