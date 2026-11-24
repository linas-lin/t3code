import type { IdeDiffFileEntry } from "./types";

export interface IdeDiffTreeFolderNode {
  readonly kind: "folder";
  readonly id: string;
  readonly name: string;
  readonly fullPath: string;
  readonly children: ReadonlyArray<IdeDiffTreeNode>;
  readonly fileCount: number;
}

export interface IdeDiffTreeFileNode {
  readonly kind: "file";
  readonly id: string;
  readonly name: string;
  readonly entry: IdeDiffFileEntry;
}

export type IdeDiffTreeNode = IdeDiffTreeFolderNode | IdeDiffTreeFileNode;

export function filterIdeDiffEntries(
  entries: ReadonlyArray<IdeDiffFileEntry>,
  options: {
    readonly query: string;
    readonly hideViewed: boolean;
    readonly hideTests: boolean;
    readonly isViewed: (entry: IdeDiffFileEntry) => boolean;
    readonly keepFileKey?: string | null | undefined;
  },
): ReadonlyArray<IdeDiffFileEntry> {
  const normalizedQuery = options.query.trim().toLowerCase();
  const tokens = normalizedQuery.length > 0 ? normalizedQuery.split(/\s+/).filter(Boolean) : [];

  return entries.filter((entry) => {
    if (tokens.length > 0) {
      const target = `${entry.path} ${entry.previousPath ?? ""}`.toLowerCase();
      if (!tokens.every((token) => target.includes(token))) {
        return false;
      }
      if (options.hideTests && entry.isTest) return false;
      if (options.hideViewed && options.isViewed(entry)) return false;
      return true;
    }

    if (options.keepFileKey && entry.fileKey === options.keepFileKey) {
      return true;
    }
    if (options.hideTests && entry.isTest) return false;
    if (options.hideViewed && options.isViewed(entry)) return false;
    return true;
  });
}

interface MutableFolder {
  name: string;
  fullPath: string;
  folders: Map<string, MutableFolder>;
  files: Array<{ name: string; entry: IdeDiffFileEntry }>;
}

const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

function finalizeFolder(folder: MutableFolder): IdeDiffTreeFolderNode {
  let current = folder;
  let compactedName = folder.name;
  let compactedPath = folder.fullPath;

  // Compact Middle Packages (IntelliJ IDEA style): collapse chains of single-child folders.
  while (current.files.length === 0 && current.folders.size === 1) {
    const onlyChild = current.folders.values().next().value;
    if (!onlyChild) break;
    compactedName = `${compactedName}/${onlyChild.name}`;
    compactedPath = onlyChild.fullPath;
    current = onlyChild;
  }

  const childFolders = Array.from(current.folders.values())
    .map(finalizeFolder)
    .toSorted((left, right) => naturalCompare(left.name, right.name));

  const childFiles: IdeDiffTreeFileNode[] = current.files
    .toSorted((left, right) => naturalCompare(left.name, right.name))
    .map(({ name, entry }) => ({
      kind: "file",
      id: `file:${entry.fileKey}`,
      name,
      entry,
    }));

  const children: IdeDiffTreeNode[] = [...childFolders, ...childFiles];
  const fileCount =
    childFiles.length + childFolders.reduce((sum, child) => sum + child.fileCount, 0);

  return {
    kind: "folder",
    id: `folder:${compactedPath}`,
    name: compactedName,
    fullPath: compactedPath,
    children,
    fileCount,
  };
}

export function buildCompactIdeDiffTree(
  entries: ReadonlyArray<IdeDiffFileEntry>,
): ReadonlyArray<IdeDiffTreeNode> {
  const root: MutableFolder = {
    name: "",
    fullPath: "",
    folders: new Map(),
    files: [],
  };

  for (const entry of entries) {
    const normalized = entry.path.replaceAll("\\", "/").replace(/^\/+/, "");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let current = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const segment = parts[index]!;
      const nextPath = current.fullPath ? `${current.fullPath}/${segment}` : segment;
      let child = current.folders.get(segment);
      if (!child) {
        child = {
          name: segment,
          fullPath: nextPath,
          folders: new Map(),
          files: [],
        };
        current.folders.set(segment, child);
      }
      current = child;
    }

    const fileName = parts.at(-1) ?? normalized;
    current.files.push({ name: fileName, entry });
  }

  const topFolders = Array.from(root.folders.values())
    .map(finalizeFolder)
    .toSorted((left, right) => naturalCompare(left.name, right.name));

  const topFiles: IdeDiffTreeFileNode[] = root.files
    .toSorted((left, right) => naturalCompare(left.name, right.name))
    .map(({ name, entry }) => ({
      kind: "file",
      id: `file:${entry.fileKey}`,
      name,
      entry,
    }));

  return [...topFolders, ...topFiles];
}

export function flattenTreeFileEntries(
  nodes: ReadonlyArray<IdeDiffTreeNode>,
): ReadonlyArray<IdeDiffFileEntry> {
  const result: IdeDiffFileEntry[] = [];
  const visit = (items: ReadonlyArray<IdeDiffTreeNode>) => {
    for (const node of items) {
      if (node.kind === "file") {
        result.push(node.entry);
      } else {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return result;
}

export function findNextUnviewedEntry(
  entries: ReadonlyArray<IdeDiffFileEntry>,
  currentFileKey: string | null,
  isViewed: (entry: IdeDiffFileEntry) => boolean,
): IdeDiffFileEntry | null {
  if (entries.length === 0) return null;
  const currentIndex = currentFileKey
    ? entries.findIndex((entry) => entry.fileKey === currentFileKey)
    : -1;
  const start = currentIndex >= 0 ? currentIndex + 1 : 0;

  for (let offset = 0; offset < entries.length; offset += 1) {
    const candidate = entries[(start + offset) % entries.length];
    if (candidate && candidate.fileKey !== currentFileKey && !isViewed(candidate)) {
      return candidate;
    }
  }
  return null;
}
