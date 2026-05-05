"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDependencyGraph = buildDependencyGraph;
exports.findDependents = findDependents;
exports.findDependencies = findDependencies;
exports.findTransitiveDependencies = findTransitiveDependencies;
exports.findCircularDependencies = findCircularDependencies;
exports.getGraphStats = getGraphStats;
const dependencyScanner_1 = require("./dependencyScanner");
/**
 * Builds a dependency graph from a ShowyNode tree
 */
async function buildDependencyGraph(rootNode) {
    const graph = {
        nodes: new Map(),
        nodesByPath: new Map(),
    };
    // First pass: collect all file paths
    const allFiles = [];
    collectFilePaths(rootNode, allFiles);
    // Second pass: scan dependencies for each file
    for (const filePath of allFiles) {
        const nodeId = `node_${graph.nodes.size}`;
        const dependencies = [];
        try {
            const rawDependencies = await (0, dependencyScanner_1.scanFileDependencies)(filePath);
            // Try to resolve each dependency
            for (const dep of rawDependencies) {
                const resolved = await (0, dependencyScanner_1.resolveDependencyPath)(dep, filePath);
                if (resolved && allFiles.includes(resolved)) {
                    dependencies.push(resolved);
                }
            }
        }
        catch (error) {
            console.error(`Failed to build dependencies for ${filePath}:`, error);
        }
        graph.nodes.set(nodeId, {
            id: nodeId,
            path: filePath,
            dependencies,
            dependents: [],
        });
        graph.nodesByPath.set(filePath, nodeId);
    }
    // Third pass: build reverse dependencies (dependents)
    for (const node of graph.nodes.values()) {
        for (const depPath of node.dependencies) {
            const depNodeId = graph.nodesByPath.get(depPath);
            if (depNodeId) {
                const depNode = graph.nodes.get(depNodeId);
                if (depNode && !depNode.dependents.includes(node.path)) {
                    depNode.dependents.push(node.path);
                }
            }
        }
    }
    return graph;
}
/**
 * Recursively collects all file paths from a ShowyNode tree
 */
function collectFilePaths(node, files) {
    if (node.type === 'file') {
        files.push(node.path);
    }
    else if (node.type === 'folder' && node.children) {
        for (const child of node.children) {
            collectFilePaths(child, files);
        }
    }
}
/**
 * Finds all files that depend on a given file
 */
function findDependents(graph, filePath) {
    const nodeId = graph.nodesByPath.get(filePath);
    if (!nodeId) {
        return [];
    }
    const node = graph.nodes.get(nodeId);
    return node ? node.dependents : [];
}
/**
 * Finds all files that a given file depends on
 */
function findDependencies(graph, filePath) {
    const nodeId = graph.nodesByPath.get(filePath);
    if (!nodeId) {
        return [];
    }
    const node = graph.nodes.get(nodeId);
    return node ? node.dependencies : [];
}
/**
 * Finds the transitive dependencies (all files indirectly depended on)
 */
function findTransitiveDependencies(graph, filePath, visited = new Set()) {
    if (visited.has(filePath)) {
        return [];
    }
    visited.add(filePath);
    const direct = findDependencies(graph, filePath);
    const all = [...direct];
    for (const dep of direct) {
        const transitive = findTransitiveDependencies(graph, dep, visited);
        for (const t of transitive) {
            if (!all.includes(t)) {
                all.push(t);
            }
        }
    }
    return all;
}
/**
 * Detects circular dependencies
 */
function findCircularDependencies(graph) {
    const circles = [];
    const visited = new Set();
    const recursionStack = new Set();
    for (const nodeId of graph.nodes.keys()) {
        if (!visited.has(nodeId)) {
            findCirclesFromNode(graph, nodeId, visited, recursionStack, [], circles);
        }
    }
    return circles;
}
function findCirclesFromNode(graph, nodeId, visited, stack, path, circles) {
    visited.add(nodeId);
    stack.add(nodeId);
    path.push(nodeId);
    const node = graph.nodes.get(nodeId);
    if (node) {
        for (const depPath of node.dependencies) {
            const depNodeId = graph.nodesByPath.get(depPath);
            if (!depNodeId) {
                continue;
            }
            if (!visited.has(depNodeId)) {
                findCirclesFromNode(graph, depNodeId, visited, stack, path, circles);
            }
            else if (stack.has(depNodeId)) {
                // Found a cycle
                const cycleStart = path.indexOf(depNodeId);
                const cycle = path.slice(cycleStart).map((id) => {
                    const n = graph.nodes.get(id);
                    return n ? n.path : id;
                });
                if (!circles.some((c) => arraysEqual(c, cycle))) {
                    circles.push(cycle);
                }
            }
        }
    }
    path.pop();
    stack.delete(nodeId);
}
function arraysEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((val, idx) => val === b[idx]);
}
/**
 * Gets statistics about the dependency graph
 */
function getGraphStats(graph) {
    let totalDeps = 0;
    let filesWithNoDeps = 0;
    let filesWithNoDependent = 0;
    for (const node of graph.nodes.values()) {
        totalDeps += node.dependencies.length;
        if (node.dependencies.length === 0) {
            filesWithNoDeps++;
        }
        if (node.dependents.length === 0) {
            filesWithNoDependent++;
        }
    }
    return {
        totalFiles: graph.nodes.size,
        totalDependencies: totalDeps,
        averageDependenciesPerFile: totalDeps / Math.max(graph.nodes.size, 1),
        filesWithNoDependencies: filesWithNoDeps,
        filesWithNoDependent: filesWithNoDependent,
    };
}
//# sourceMappingURL=dependencyGraph.js.map