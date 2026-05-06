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
exports.scanFileDependencies = scanFileDependencies;
exports.resolveDependencyPath = resolveDependencyPath;
exports.clearDependencyCache = clearDependencyCache;
exports.getCacheStats = getCacheStats;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const dependencyCache = new Map();
/**
 * Detects the language of a file based on its extension
 */
function detectLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        return 'javascript';
    }
    else if (['.py', '.pyw'].includes(ext)) {
        return 'python';
    }
    else if (['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'].includes(ext)) {
        return 'cpp';
    }
    return null;
}
/**
 * Reads a file and extracts dependency paths based on language
 */
async function scanFileDependencies(filePath) {
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
        const stat = await fs.promises.stat(filePath);
        const maxSize = 100 * 1024;
        const bytesToRead = Math.min(stat.size, maxSize);
        const buffer = Buffer.alloc(bytesToRead);
        const fd = await fs.promises.open(filePath, 'r');
        await fd.read(buffer, 0, bytesToRead, 0);
        await fd.close();
        const content = buffer.toString('utf-8');
        const dependencies = extractDependencies(content, language, filePath);
        // Cache the result
        dependencyCache.set(filePath, {
            timestamp: Date.now(),
            dependencies,
        });
        return dependencies;
    }
    catch (error) {
        console.error(`Failed to scan dependencies for ${filePath}:`, error);
        return [];
    }
}
/**
 * Extracts raw dependency strings from file content
 */
function extractDependencies(content, language, filePath) {
    const dependencies = new Set();
    if (language === 'javascript') {
        // Extract ES6 imports (including type imports and side-effect imports)
        // Matches: import X from 'path', import type { X } from 'path', import './styles.css'
        const es6Pattern = /import\s+(?:type\s+)?(?:{[^}]*}|[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
        let match;
        while ((match = es6Pattern.exec(content)) !== null) {
            dependencies.add(match[1]);
        }
        // Extract CommonJS requires
        const commonjsPattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        while ((match = commonjsPattern.exec(content)) !== null) {
            dependencies.add(match[1]);
        }
    }
    else if (language === 'python') {
        // Matches: import module or from module import
        // Note: from . import X (relative imports) will have empty match[1], handled by moduleName check
        const importPattern = /^(?:from\s+([^\s.]+)|import\s+([^\s,]+))/gm;
        let match;
        while ((match = importPattern.exec(content)) !== null) {
            const moduleName = match[1] || match[2];
            if (moduleName) {
                dependencies.add(moduleName.split('.')[0]); // Top-level module only
            }
        }
    }
    else if (language === 'cpp') {
        // Matches: #include "path/file.h" or #include <path/file.h>
        const includePattern = /#include\s+[<"]([^>"]+)[>"]/g;
        let match;
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
async function resolveDependencyPath(dependency, fromFile) {
    const fromDir = path.dirname(fromFile);
    const language = detectLanguage(fromFile);
    if (!language) {
        return null;
    }
    try {
        if (language === 'javascript') {
            return await resolveJavaScriptDependency(dependency, fromDir);
        }
        else if (language === 'python') {
            return await resolvePythonDependency(dependency, fromDir);
        }
        else if (language === 'cpp') {
            return await resolveCppDependency(dependency, fromDir);
        }
    }
    catch (error) {
        console.error(`Failed to resolve dependency "${dependency}" from ${fromFile}:`, error);
    }
    return null;
}
/**
 * Resolves a JavaScript/TypeScript import path
 */
async function resolveJavaScriptDependency(dependency, fromDir) {
    // Handle relative imports
    if (dependency.startsWith('.')) {
        const resolvedPath = path.join(fromDir, dependency);
        // Phase 1: Try with various file extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'];
        for (const ext of extensions) {
            const filePath = resolvedPath + ext;
            try {
                await fs.promises.access(filePath);
                return filePath;
            }
            catch {
                // File doesn't exist, try next extension
            }
        }
        // Phase 2: Check if it's a directory with an index file
        try {
            const stat = await fs.promises.stat(resolvedPath);
            if (stat.isDirectory()) {
                for (const indexExt of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
                    const indexPath = path.join(resolvedPath, `index${indexExt}`);
                    try {
                        await fs.promises.access(indexPath);
                        return indexPath;
                    }
                    catch {
                        // Index file doesn't exist, try next extension
                    }
                }
            }
        }
        catch {
            // Path doesn't exist
        }
    }
    // For node_modules, we just return null (can't easily resolve all)
    return null;
}
/**
 * Resolves a Python import path
 */
async function resolvePythonDependency(dependency, fromDir) {
    // Try relative import from same directory
    const pyFile = path.join(fromDir, `${dependency}.py`);
    try {
        await fs.promises.access(pyFile);
        return pyFile;
    }
    catch {
        // File doesn't exist
    }
    // Try as a package (directory with __init__.py)
    const pkgDir = path.join(fromDir, dependency);
    try {
        const stat = await fs.promises.stat(pkgDir);
        if (stat.isDirectory()) {
            const initFile = path.join(pkgDir, '__init__.py');
            try {
                await fs.promises.access(initFile);
                return initFile;
            }
            catch {
                // __init__.py doesn't exist
            }
        }
    }
    catch {
        // Directory doesn't exist
    }
    return null;
}
/**
 * Resolves a C++ include path
 */
async function resolveCppDependency(dependency, fromDir) {
    // Try as relative path from current file's directory
    const resolvedPath = path.join(fromDir, dependency);
    try {
        await fs.promises.access(resolvedPath);
        return resolvedPath;
    }
    catch {
        // File doesn't exist
    }
    // Try with .h or .hpp extensions if not already present
    if (!dependency.endsWith('.h') && !dependency.endsWith('.hpp')) {
        for (const ext of ['.h', '.hpp']) {
            const withExt = resolvedPath + ext;
            try {
                await fs.promises.access(withExt);
                return withExt;
            }
            catch {
                // File doesn't exist
            }
        }
    }
    return null;
}
/**
 * Clears the dependency cache (useful for testing or manual refresh)
 */
function clearDependencyCache() {
    dependencyCache.clear();
}
/**
 * Gets cache statistics (for debugging)
 */
function getCacheStats() {
    return {
        size: dependencyCache.size,
        entries: Array.from(dependencyCache.keys()),
    };
}
//# sourceMappingURL=dependencyScanner.js.map