import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";

import { isCtStudioWorkspace } from "../ctStudioConfig";
import type { ExplorerRepoScope } from "./types";

export function normalizeRepoCwd(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  const normalized = trimmed.replaceAll("\\", "/");
  if (normalized === "/") return "/";
  return normalized.replace(/\/+$/, "");
}

export function basenameOfPath(rawPath: string): string {
  const normalized = normalizeRepoCwd(rawPath);
  if (!normalized || normalized === "/") return normalized;
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function joinRepoSubpath(rootCwd: string, childPath: string): string {
  const normalizedRoot = normalizeRepoCwd(rootCwd);
  const normalizedChild = childPath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedChild) return normalizedRoot;
  return normalizedRoot === "/" ? `/${normalizedChild}` : `${normalizedRoot}/${normalizedChild}`;
}

export function buildRepoScopeId(environmentId: EnvironmentId, cwd: string): string {
  return `${environmentId}::${normalizeRepoCwd(cwd)}`;
}

export interface ProjectSummaryForScope {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface CustomRepoRecord {
  readonly name: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
}

/**
 * Merges registered projects, auto-discovered `ct-studio/repos/*` entries, and user custom paths.
 * Deduplicates by normalized cwd (and prefers registered project entries when both share the same name
 * under `ct-studio/repos/<name>` and a direct checkout path).
 */
export function buildAvailableRepoScopes(input: {
  readonly projects: ReadonlyArray<ProjectSummaryForScope>;
  readonly ctStudioRepos: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly name: string;
    readonly cwd: string;
  }>;
  readonly customRepos: ReadonlyArray<CustomRepoRecord>;
}): ReadonlyArray<ExplorerRepoScope> {
  const byCwd = new Map<string, ExplorerRepoScope>();
  const registeredNamesByEnv = new Set<string>();

  for (const project of input.projects) {
    const cwd = normalizeRepoCwd(project.workspaceRoot);
    if (!cwd) continue;
    const isCtRoot = isCtStudioWorkspace(project);
    const id = buildRepoScopeId(project.environmentId, cwd);
    const name = project.title.trim() || basenameOfPath(cwd);
    registeredNamesByEnv.add(`${project.environmentId}::${name.toLowerCase()}`);
    byCwd.set(id, {
      id,
      name,
      cwd,
      environmentId: project.environmentId,
      origin: "project",
      isCtStudioRoot: isCtRoot,
    });
  }

  for (const repo of input.ctStudioRepos) {
    const cwd = normalizeRepoCwd(repo.cwd);
    if (!cwd) continue;
    const id = buildRepoScopeId(repo.environmentId, cwd);
    if (byCwd.has(id)) continue;
    // Skip duplicate symlinked ct-studio/repos/<name> if the same repo is already a registered project.
    if (registeredNamesByEnv.has(`${repo.environmentId}::${repo.name.toLowerCase()}`)) {
      continue;
    }
    byCwd.set(id, {
      id,
      name: repo.name,
      cwd,
      environmentId: repo.environmentId,
      origin: "ct-repos",
    });
  }

  for (const custom of input.customRepos) {
    const cwd = normalizeRepoCwd(custom.cwd);
    if (!cwd) continue;
    const id = buildRepoScopeId(custom.environmentId, cwd);
    if (byCwd.has(id)) continue;
    byCwd.set(id, {
      id,
      name: custom.name.trim() || basenameOfPath(cwd),
      cwd,
      environmentId: custom.environmentId,
      origin: "custom",
    });
  }

  // Sort: business repos first (alphabetical), ct-studio root last to discourage accidental worktree scans.
  return Array.from(byCwd.values()).toSorted((left, right) => {
    if (Boolean(left.isCtStudioRoot) !== Boolean(right.isCtStudioRoot)) {
      return left.isCtStudioRoot ? 1 : -1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function globTokenToRegex(token: string): RegExp {
  const escaped = token
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  // If user wrote a bare filename glob like `*.java`, match anywhere in path or ending.
  if (token.startsWith("*") && !token.includes("/")) {
    return new RegExp(`(?:^|/)${escaped}$`, "i");
  }
  return new RegExp(escaped, "i");
}

/**
 * Supports comma/space separated include & exclude path filters, e.g.:
 * `*.java, !*Test.java, order/`
 */
export function matchesPathFilter(relativePath: string, filterExpression: string): boolean {
  const raw = filterExpression.trim();
  if (!raw) return true;
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const tokens = raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length === 0) return true;

  const includes: RegExp[] = [];
  const excludes: RegExp[] = [];
  for (const token of tokens) {
    if (token.startsWith("!") && token.length > 1) {
      excludes.push(globTokenToRegex(token.slice(1)));
    } else if (!token.startsWith("!")) {
      includes.push(globTokenToRegex(token));
    }
  }

  if (excludes.some((pattern) => pattern.test(normalizedPath))) {
    return false;
  }
  if (includes.length > 0 && !includes.some((pattern) => pattern.test(normalizedPath))) {
    return false;
  }
  return true;
}

export function pickInitialSelectedScopeIds(input: {
  readonly available: ReadonlyArray<ExplorerRepoScope>;
  readonly activeCwd: string | null | undefined;
  readonly activeEnvironmentId: EnvironmentId | null | undefined;
}): ReadonlyArray<string> {
  if (input.available.length === 0) return [];
  if (input.activeCwd && input.activeEnvironmentId) {
    const normalizedActive = normalizeRepoCwd(input.activeCwd);
    const activeMatch = input.available.find(
      (scope) =>
        scope.environmentId === input.activeEnvironmentId &&
        scope.cwd === normalizedActive &&
        !scope.isCtStudioRoot,
    );
    if (activeMatch) return [activeMatch.id];
  }
  // When in ct-studio root, prefer selecting nothing by default if many repos exist? No:
  // if there is a non-ct-studio repo (e.g. first business repo), leave empty so user consciously picks,
  // unless there is only 1 business repo total.
  const businessRepos = input.available.filter((scope) => !scope.isCtStudioRoot);
  if (businessRepos.length === 1) {
    return [businessRepos[0]!.id];
  }
  return [];
}

const WRAPPER_DIR_SEGMENTS = new Set([
  "backend",
  "frontend",
  "services",
  "service",
  "apps",
  "packages",
  "modules",
  "libs",
]);

/**
 * Formats a file's parent directory for narrow sidebars by keeping the module name
 * and trailing package/directory segments (middle-elided for deep Java/monorepo paths).
 */
export function formatCompactParentPath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) return "";
  const segments = normalized.slice(0, lastSlash).split("/").filter(Boolean);
  if (segments.length <= 3) return segments.join("/");

  const first = segments[0]!;
  const moduleHead =
    WRAPPER_DIR_SEGMENTS.has(first.toLowerCase()) && segments.length >= 2 ? segments[1]! : first;
  const tail = segments.slice(-2).join("/");
  if (tail === moduleHead || tail.startsWith(`${moduleHead}/`)) {
    return `…/${tail}`;
  }
  return `${moduleHead} / … / ${tail}`;
}

export function isTestFilePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    /(?:^|\/)(?:test|tests|__tests__|spec|specs)\//i.test(normalized) ||
    /(?:Test|Tests|Spec|IT)\.[a-z0-9]+$/i.test(normalized) ||
    /\.(?:test|spec)\.[a-z0-9]+$/i.test(normalized)
  );
}

/**
 * Finds highlight ranges in a filename for contiguous substring or fuzzy subsequence queries.
 */
export function findFileNameMatchRanges(
  fileName: string,
  query: string,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const trimmed = query.trim();
  if (!trimmed || !fileName) return [];
  const lowerName = fileName.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();

  const directIdx = lowerName.indexOf(lowerQuery);
  if (directIdx >= 0) {
    return [{ start: directIdx, end: directIdx + lowerQuery.length }];
  }

  const indices: number[] = [];
  let cursor = 0;
  for (let i = 0; i < lowerQuery.length; i += 1) {
    const ch = lowerQuery[i]!;
    if (ch === "/" || ch === " ") continue;
    const found = lowerName.indexOf(ch, cursor);
    if (found < 0) return [];
    indices.push(found);
    cursor = found + 1;
  }
  if (indices.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of indices) {
    const prev = ranges[ranges.length - 1];
    if (prev && prev.end === idx) {
      prev.end = idx + 1;
    } else {
      ranges.push({ start: idx, end: idx + 1 });
    }
  }
  return ranges;
}

export interface VisibleTreeRow {
  readonly key: string;
  readonly path: string;
  readonly parentPath: string;
  readonly kind: "directory" | "file";
  readonly name: string;
  readonly depth: number;
  readonly ignored: boolean;
  readonly expanded: boolean;
  readonly loadingChildren: boolean;
  readonly emptyChildren: boolean;
  /** True when this row's own name matches the active tree filter query. */
  readonly isMatch?: boolean | undefined;
}

/**
 * Flattens currently expanded directories into a deterministic screen-order list
 * so Tree rendering and keyboard navigation share one source of truth.
 */
export function flattenVisibleTreeRows(input: {
  readonly scopeId: string;
  readonly dirEntries: Readonly<Record<string, ReadonlyArray<ProjectEntry>>>;
  readonly expandedDirs: ReadonlySet<string>;
}): ReadonlyArray<VisibleTreeRow> {
  const rows: VisibleTreeRow[] = [];

  const visit = (directoryPath: string, depth: number) => {
    const cacheKey = `${input.scopeId}::${directoryPath}`;
    const entries = input.dirEntries[cacheKey];
    if (!entries) return;

    for (const entry of entries) {
      const rowKey = `${input.scopeId}::${entry.path}`;
      const isDir = entry.kind === "directory";
      const expanded = isDir && input.expandedDirs.has(rowKey);
      const childEntries = expanded ? input.dirEntries[rowKey] : undefined;
      rows.push({
        key: rowKey,
        path: entry.path,
        parentPath: directoryPath,
        kind: isDir ? "directory" : "file",
        name: basenameOfPath(entry.path),
        depth,
        ignored: Boolean(entry.ignored),
        expanded,
        loadingChildren: expanded && childEntries === undefined,
        emptyChildren: expanded && childEntries !== undefined && childEntries.length === 0,
      });
      if (expanded && childEntries && childEntries.length > 0) {
        visit(entry.path, depth + 1);
      }
    }
  };

  visit("", 0);
  return rows;
}

export function ancestorDirectoryPaths(entryPath: string): ReadonlyArray<string> {
  const normalized = entryPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return [];
  const parts = normalized.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    ancestors.push(parts.slice(0, i + 1).join("/"));
  }
  return ancestors;
}

interface FilteredTrieNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  ignored: boolean;
  children: Map<string, FilteredTrieNode>;
}

/**
 * Builds a compacted, screen-ordered tree from flat searchEntries results (files + folders),
 * merging single-child intermediate directory chains (Compact Middle Packages).
 */
export function buildFilteredTreeRows(input: {
  readonly scopeId: string;
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly collapsedKeys: ReadonlySet<string>;
  readonly query?: string | undefined;
}): ReadonlyArray<VisibleTreeRow> {
  if (input.entries.length === 0) return [];

  const rootChildren = new Map<string, FilteredTrieNode>();

  for (const entry of input.entries) {
    const normalized = entry.path.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    if (!normalized) continue;
    const parts = normalized.split("/").filter(Boolean);
    let siblings = rootChildren;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const currentPath = parts.slice(0, i + 1).join("/");
      const isLast = i === parts.length - 1;
      const existing = siblings.get(part);
      if (existing) {
        if (isLast && entry.kind === "file" && existing.children.size === 0) {
          existing.kind = "file";
        }
        if (isLast && entry.ignored) {
          existing.ignored = true;
        }
        siblings = existing.children;
      } else {
        const node: FilteredTrieNode = {
          name: part,
          path: currentPath,
          kind: isLast ? entry.kind : "directory",
          ignored: isLast ? Boolean(entry.ignored) : false,
          children: new Map(),
        };
        siblings.set(part, node);
        siblings = node.children;
      }
    }
  }

  const compactNode = (node: FilteredTrieNode): FilteredTrieNode => {
    let current = node;
    while (current.kind === "directory" && current.children.size === 1) {
      const onlyChild = current.children.values().next().value;
      if (!onlyChild || onlyChild.kind !== "directory") break;
      current = {
        name: `${current.name}/${onlyChild.name}`,
        path: onlyChild.path,
        kind: "directory",
        ignored: current.ignored || onlyChild.ignored,
        children: onlyChild.children,
      };
    }
    return current;
  };

  const rows: VisibleTreeRow[] = [];

  const visitMap = (nodeMap: Map<string, FilteredTrieNode>, parentPath: string, depth: number) => {
    const sorted = Array.from(nodeMap.values())
      .map(compactNode)
      .toSorted((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
      });

    for (const node of sorted) {
      const rowKey = `${input.scopeId}::${node.path}`;
      const isDir = node.kind === "directory";
      const hasChildren = node.children.size > 0;
      const expanded = isDir && hasChildren && !input.collapsedKeys.has(rowKey);
      const isMatch = Boolean(
        input.query && findFileNameMatchRanges(node.name, input.query).length > 0,
      );
      rows.push({
        key: rowKey,
        path: node.path,
        parentPath,
        kind: node.kind,
        name: node.name,
        depth,
        ignored: node.ignored,
        expanded,
        loadingChildren: false,
        emptyChildren: false,
        isMatch,
      });
      if (expanded) {
        visitMap(node.children, node.path, depth + 1);
      }
    }
  };

  visitMap(rootChildren, "", 0);
  return rows;
}
