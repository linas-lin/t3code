import type { ProjectEntry } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  CaseSensitiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  Loader2Icon,
  RegexIcon,
  SearchIcon,
  WholeWordIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  ancestorDirectoryPaths,
  basenameOfPath,
  buildFilteredTreeRows,
  findFileNameMatchRanges,
  flattenVisibleTreeRows,
  formatCompactParentPath,
  isTestFilePath,
  type VisibleTreeRow,
} from "./repoScope.logic";
import type {
  ExplorerContentHit,
  ExplorerFileTarget,
  ExplorerRepoScope,
  ExplorerSearchMode,
} from "./types";
import {
  useDirectoryLoader,
  useMultiRepoContentSearch,
  useMultiRepoFileSearch,
  useRepoTreeSearch,
} from "./useMultiRepoSearch";

export interface CodeExplorerSidebarProps {
  readonly open: boolean;
  readonly mode: ExplorerSearchMode;
  readonly focusSearchToken: number;
  readonly scopes: ReadonlyArray<ExplorerRepoScope>;
  readonly activeTabKey: string | null;
  readonly activeLineNumber: number | null;
  readonly width: number;
  readonly onWidthChange: (width: number) => void;
  readonly onModeChange: (mode: ExplorerSearchMode) => void;
  readonly onOpenTarget: (target: ExplorerFileTarget) => void;
  readonly onFocusEditor: () => void;
}

interface NavigableCandidate {
  readonly key: string;
  readonly target: ExplorerFileTarget;
  readonly fullPathLabel: string;
}

function renderHighlightedLine(hit: ExplorerContentHit) {
  const text = hit.lineContent.trimStart();
  const trimOffset = hit.lineContent.length - text.length;
  if (hit.matchRanges.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of hit.matchRanges) {
    const start = Math.max(0, range.start - trimOffset);
    const end = Math.max(start, range.end - trimOffset);
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (end > start) {
      parts.push(
        <mark key={`${start}-${end}`} className="rounded-xs bg-warning/35 px-0.5 text-foreground">
          {text.slice(start, end)}
        </mark>,
      );
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function renderHighlightedFileName(fileName: string, query: string) {
  const ranges = findFileNameMatchRanges(fileName, query);
  if (ranges.length === 0) return fileName;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(fileName.slice(cursor, range.start));
    if (range.end > range.start) {
      parts.push(
        <mark
          key={`${range.start}-${range.end}`}
          className="rounded-xs bg-warning/35 px-0.5 text-foreground"
        >
          {fileName.slice(range.start, range.end)}
        </mark>,
      );
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < fileName.length) parts.push(fileName.slice(cursor));
  return parts;
}

function codeHitCandidateKey(repoId: string, relativePath: string, lineNumber: number): string {
  return `code::${repoId}::${relativePath}::${lineNumber}`;
}

export function CodeExplorerSidebar({
  open,
  mode,
  focusSearchToken,
  scopes,
  activeTabKey,
  activeLineNumber,
  width,
  onWidthChange,
  onModeChange,
  onOpenTarget,
  onFocusEditor,
}: CodeExplorerSidebarProps) {
  const gt = useGT();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const treeFilterInputRef = useRef<HTMLInputElement | null>(null);
  const lastFocusTokenRef = useRef<number>(-1);
  const resultsContainerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const requestedDirsRef = useRef<Set<string>>(new Set());

  const [query, setQuery] = useState("");
  const [pathFilter, setPathFilter] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [triggerNonce, setTriggerNonce] = useState(0);
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedCandidateKey, setSelectedCandidateKey] = useState<string | null>(null);

  // Tree browsing state
  const [treeRepoId, setTreeRepoId] = useState<string | null>(null);
  const [treeFilter, setTreeFilter] = useState("");
  const [filteredCollapsedDirs, setFilteredCollapsedDirs] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedTreeKey, setSelectedTreeKey] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [dirEntries, setDirEntries] = useState<
    Readonly<Record<string, ReadonlyArray<ProjectEntry>>>
  >({});
  const { loadDirectory } = useDirectoryLoader();

  // Focus search input in Code/Files mode or results container in Tree mode so arrows work immediately.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses search input or tree list when Code Explorer opens or cycles modes
  useEffect(() => {
    if (!open || focusSearchToken < 0) return;
    const shouldSelectAll = lastFocusTokenRef.current !== focusSearchToken;
    lastFocusTokenRef.current = focusSearchToken;
    const frame = window.requestAnimationFrame(() => {
      if (mode === "tree") {
        resultsContainerRef.current?.focus({ preventScroll: true });
        return;
      }
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      if (shouldSelectAll) {
        input.select();
      } else {
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusSearchToken, mode, open]);

  const contentSearch = useMultiRepoContentSearch({
    enabled: open && mode === "code",
    scopes,
    query,
    pathFilter,
    caseSensitive,
    wholeWord,
    useRegex,
    triggerNonce,
  });

  const fileSearch = useMultiRepoFileSearch({
    enabled: open && mode === "files",
    scopes,
    query,
    pathFilter,
  });

  const activeTreeScope = scopes.find((scope) => scope.id === treeRepoId) ?? scopes[0] ?? null;
  const isTreeFiltered = mode === "tree" && treeFilter.trim().length > 0;
  const treeSearch = useRepoTreeSearch({
    enabled: open && mode === "tree",
    scope: activeTreeScope,
    query: treeFilter,
  });

  const ensureDirLoaded = (scope: ExplorerRepoScope, directoryPath: string) => {
    const cacheKey = `${scope.id}::${directoryPath}`;
    if (dirEntries[cacheKey] || requestedDirsRef.current.has(cacheKey)) return;
    requestedDirsRef.current.add(cacheKey);
    void loadDirectory(scope, directoryPath)
      .then((entries) => {
        setDirEntries((current) => ({ ...current, [cacheKey]: entries }));
      })
      .finally(() => {
        requestedDirsRef.current.delete(cacheKey);
      });
  };

  // Load root directory when switching to Tree mode or changing selected tree repo.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads root directory entries when entering Tree mode for a scope
  useEffect(() => {
    if (!open || mode !== "tree" || !activeTreeScope) return;
    const cacheKey = `${activeTreeScope.id}::`;
    if (dirEntries[cacheKey]) return;
    let cancelled = false;
    void loadDirectory(activeTreeScope, "").then((entries) => {
      if (!cancelled) {
        setDirEntries((current) => ({ ...current, [cacheKey]: entries }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeTreeScope, dirEntries, loadDirectory, mode, open]);

  // Flat candidate list for keyboard navigation (ArrowUp/ArrowDown + live preview + Enter).
  const navigableCandidates: NavigableCandidate[] = [];
  if (mode === "files") {
    for (const file of fileSearch.files) {
      navigableCandidates.push({
        key: file.key,
        target: {
          repoId: file.repoId,
          repoName: file.repoName,
          cwd: file.cwd,
          environmentId: file.environmentId,
          relativePath: file.relativePath,
        },
        fullPathLabel: `${file.repoName} / ${file.relativePath}`,
      });
    }
  } else if (mode === "code") {
    for (const repoGroup of contentSearch.groups) {
      if (collapsedKeys.has(`repo:${repoGroup.repoId}`)) continue;
      for (const fileGroup of repoGroup.files) {
        if (collapsedKeys.has(`file:${fileGroup.key}`)) continue;
        for (const hit of fileGroup.hits) {
          navigableCandidates.push({
            key: codeHitCandidateKey(hit.repoId, hit.relativePath, hit.lineNumber),
            target: {
              repoId: hit.repoId,
              repoName: hit.repoName,
              cwd: hit.cwd,
              environmentId: hit.environmentId,
              relativePath: hit.relativePath,
              lineNumber: hit.lineNumber,
              column: (hit.matchRanges[0]?.start ?? 0) + 1,
            },
            fullPathLabel: `${hit.repoName} / ${hit.relativePath}:${hit.lineNumber}`,
          });
        }
      }
    }
  }

  const activeEditorHitKey =
    mode === "code" && activeTabKey && activeLineNumber
      ? `code::${activeTabKey}::${activeLineNumber}`
      : mode === "files"
        ? activeTabKey
        : null;

  const effectiveCandidateKey =
    selectedCandidateKey && navigableCandidates.some((item) => item.key === selectedCandidateKey)
      ? selectedCandidateKey
      : activeEditorHitKey && navigableCandidates.some((item) => item.key === activeEditorHitKey)
        ? activeEditorHitKey
        : (navigableCandidates[0]?.key ?? null);

  const selectedCandidate =
    navigableCandidates.find((item) => item.key === effectiveCandidateKey) ?? null;

  const scrollCandidateIntoView = (candidateKey: string, focusButton = false) => {
    window.requestAnimationFrame(() => {
      const container = resultsContainerRef.current;
      if (!container) return;
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(candidateKey)
          : candidateKey.replaceAll('"', '\\"');
      const element = container.querySelector<HTMLElement>(`[data-candidate-key="${escaped}"]`);
      element?.scrollIntoView({ block: "nearest" });
      if (focusButton) {
        element?.focus({ preventScroll: true });
      }
    });
  };

  const selectAndPreviewCandidate = (
    candidate: NavigableCandidate,
    options?: { readonly scroll?: boolean; readonly focusButton?: boolean },
  ) => {
    setSelectedCandidateKey(candidate.key);
    onOpenTarget(candidate.target);
    if (options?.scroll) {
      scrollCandidateIntoView(candidate.key, options.focusButton);
    }
  };

  const visibleTreeRows: ReadonlyArray<VisibleTreeRow> =
    mode === "tree" && activeTreeScope
      ? isTreeFiltered
        ? buildFilteredTreeRows({
            scopeId: activeTreeScope.id,
            entries: treeSearch.entries,
            collapsedKeys: filteredCollapsedDirs,
            query: treeFilter,
          })
        : flattenVisibleTreeRows({
            scopeId: activeTreeScope.id,
            dirEntries,
            expandedDirs,
          })
      : [];

  const matchedTreeRows = isTreeFiltered ? visibleTreeRows.filter((row) => row.isMatch) : [];
  const navigableTreeRows =
    isTreeFiltered && matchedTreeRows.length > 0 ? matchedTreeRows : visibleTreeRows;

  const effectiveTreeKey =
    selectedTreeKey && visibleTreeRows.some((row) => row.key === selectedTreeKey)
      ? selectedTreeKey
      : !isTreeFiltered && activeTabKey && visibleTreeRows.some((row) => row.key === activeTabKey)
        ? activeTabKey
        : (navigableTreeRows[0]?.key ?? null);

  const selectedTreeRow = visibleTreeRows.find((row) => row.key === effectiveTreeKey) ?? null;
  const activeTreeMatchIndex =
    isTreeFiltered && matchedTreeRows.length > 0
      ? matchedTreeRows.findIndex((row) => row.key === effectiveTreeKey)
      : -1;

  const scrollTreeRowIntoView = (treeKey: string, focusButton = false) => {
    window.requestAnimationFrame(() => {
      const container = resultsContainerRef.current;
      if (!container) return;
      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(treeKey)
          : treeKey.replaceAll('"', '\\"');
      const element = container.querySelector<HTMLElement>(`[data-tree-key="${escaped}"]`);
      element?.scrollIntoView({ block: "nearest" });
      if (focusButton) {
        element?.focus({ preventScroll: true });
      }
    });
  };

  const setTreeDirectoryExpanded = (
    scope: ExplorerRepoScope,
    directoryPath: string,
    expand: boolean,
  ) => {
    const cacheKey = `${scope.id}::${directoryPath}`;
    if (isTreeFiltered) {
      setFilteredCollapsedDirs((current) => {
        const isCollapsed = current.has(cacheKey);
        if (isCollapsed === !expand) return current;
        const next = new Set(current);
        if (expand) next.delete(cacheKey);
        else next.add(cacheKey);
        return next;
      });
      return;
    }
    setExpandedDirs((current) => {
      const has = current.has(cacheKey);
      if (has === expand) return current;
      const next = new Set(current);
      if (expand) next.add(cacheKey);
      else next.delete(cacheKey);
      return next;
    });
    if (expand) {
      ensureDirLoaded(scope, directoryPath);
    }
  };

  const toggleTreeDirectory = (scope: ExplorerRepoScope, directoryPath: string) => {
    const cacheKey = `${scope.id}::${directoryPath}`;
    if (isTreeFiltered) {
      setTreeDirectoryExpanded(scope, directoryPath, filteredCollapsedDirs.has(cacheKey));
      return;
    }
    setTreeDirectoryExpanded(scope, directoryPath, !expandedDirs.has(cacheKey));
  };

  const clearTreeFilterAndReveal = (targetRow?: VisibleTreeRow | null) => {
    setTreeFilter("");
    setFilteredCollapsedDirs(new Set());
    if (!activeTreeScope || !targetRow) {
      resultsContainerRef.current?.focus({ preventScroll: true });
      return;
    }
    const dirsToExpand = [
      ...ancestorDirectoryPaths(targetRow.path),
      ...(targetRow.kind === "directory" ? [targetRow.path] : []),
    ];
    if (dirsToExpand.length > 0) {
      setExpandedDirs((current) => {
        const next = new Set(current);
        for (const dir of dirsToExpand) {
          next.add(`${activeTreeScope.id}::${dir}`);
        }
        return next;
      });
    }
    const missingDirs = ["", ...dirsToExpand].filter(
      (dir) => !dirEntries[`${activeTreeScope.id}::${dir}`],
    );
    setSelectedTreeKey(targetRow.key);
    resultsContainerRef.current?.focus({ preventScroll: true });
    if (missingDirs.length > 0) {
      const scope = activeTreeScope;
      void Promise.all(
        missingDirs.map(async (dir) => {
          const entries = await loadDirectory(scope, dir);
          return { key: `${scope.id}::${dir}`, entries };
        }),
      ).then((loaded) => {
        setDirEntries((current) => {
          const next = { ...current };
          for (const item of loaded) {
            next[item.key] = item.entries;
          }
          return next;
        });
        scrollTreeRowIntoView(targetRow.key, false);
      });
    } else {
      scrollTreeRowIntoView(targetRow.key, false);
    }
  };

  const selectAndPreviewTreeRow = (
    scope: ExplorerRepoScope,
    row: VisibleTreeRow,
    options?: { readonly scroll?: boolean; readonly focusButton?: boolean },
  ) => {
    setSelectedTreeKey(row.key);
    if (row.kind === "file") {
      onOpenTarget({
        repoId: scope.id,
        repoName: scope.name,
        cwd: scope.cwd,
        environmentId: scope.environmentId,
        relativePath: row.path,
      });
    }
    if (options?.scroll) {
      scrollTreeRowIntoView(row.key, options.focusButton);
    }
  };

  const handleSidebarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const isNext = event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "n");
    const isPrev = event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p");

    if (mode === "tree") {
      const targetEl = event.target instanceof HTMLElement ? event.target : null;
      const isTreeInput = targetEl === treeFilterInputRef.current;

      if (event.key === "Escape" && isTreeFiltered) {
        event.preventDefault();
        event.stopPropagation();
        clearTreeFilterAndReveal(selectedTreeRow);
        return;
      }

      // IDEA Speed Search: typing printable characters while browsing the tree starts filtering immediately.
      if (
        !isTreeInput &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.nativeEvent.isComposing
      ) {
        if (event.key.length === 1 && event.key !== " ") {
          event.preventDefault();
          event.stopPropagation();
          setTreeFilter((prev) => prev + event.key);
          setSelectedTreeKey(null);
          setFilteredCollapsedDirs(new Set());
          window.requestAnimationFrame(() => {
            const input = treeFilterInputRef.current;
            if (!input) return;
            input.focus();
            const len = input.value.length;
            input.setSelectionRange(len, len);
          });
          return;
        }
        if (event.key === "Backspace" && treeFilter.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          setTreeFilter((prev) => prev.slice(0, -1));
          setFilteredCollapsedDirs(new Set());
          treeFilterInputRef.current?.focus();
          return;
        }
      }

      if (!activeTreeScope || visibleTreeRows.length === 0) return;
      const focusWasOnTreeRow = Boolean(targetEl?.closest("[data-tree-key]"));
      const focusInTreeList =
        isTreeInput || focusWasOnTreeRow || targetEl === resultsContainerRef.current;

      if (isNext || isPrev || (!isTreeInput && (event.key === "Home" || event.key === "End"))) {
        event.preventDefault();
        event.stopPropagation();
        let nextRow: VisibleTreeRow | undefined;
        if (event.key === "Home") {
          nextRow = navigableTreeRows[0];
        } else if (event.key === "End") {
          nextRow = navigableTreeRows[navigableTreeRows.length - 1];
        } else if (isTreeFiltered && matchedTreeRows.length > 0) {
          // Jump directly between matched tree nodes in screen order.
          const currentVisibleIdx = visibleTreeRows.findIndex(
            (row) => row.key === effectiveTreeKey,
          );
          if (isNext) {
            nextRow =
              visibleTreeRows.find((row, idx) => idx > currentVisibleIdx && row.isMatch) ??
              matchedTreeRows[matchedTreeRows.length - 1];
          } else {
            for (let idx = currentVisibleIdx - 1; idx >= 0; idx -= 1) {
              if (visibleTreeRows[idx]?.isMatch) {
                nextRow = visibleTreeRows[idx];
                break;
              }
            }
            nextRow ??= matchedTreeRows[0];
          }
        } else {
          const currentIdx = visibleTreeRows.findIndex((row) => row.key === effectiveTreeKey);
          const delta = isNext ? 1 : -1;
          const nextIdx =
            currentIdx < 0
              ? 0
              : Math.max(0, Math.min(visibleTreeRows.length - 1, currentIdx + delta));
          nextRow = visibleTreeRows[nextIdx];
        }
        if (nextRow) {
          selectAndPreviewTreeRow(activeTreeScope, nextRow, {
            scroll: true,
            focusButton: focusWasOnTreeRow,
          });
        }
        return;
      }

      if (!selectedTreeRow) return;

      if (event.key === "ArrowRight" && !isTreeInput) {
        if (selectedTreeRow.kind !== "directory") return;
        event.preventDefault();
        event.stopPropagation();
        if (!selectedTreeRow.expanded) {
          setTreeDirectoryExpanded(activeTreeScope, selectedTreeRow.path, true);
        } else {
          const currentIdx = visibleTreeRows.findIndex((row) => row.key === selectedTreeRow.key);
          const firstChild = visibleTreeRows[currentIdx + 1];
          if (firstChild && firstChild.parentPath === selectedTreeRow.path) {
            selectAndPreviewTreeRow(activeTreeScope, firstChild, {
              scroll: true,
              focusButton: focusWasOnTreeRow,
            });
          }
        }
        return;
      }

      if (event.key === "ArrowLeft" && !isTreeInput) {
        event.preventDefault();
        event.stopPropagation();
        if (selectedTreeRow.kind === "directory" && selectedTreeRow.expanded) {
          setTreeDirectoryExpanded(activeTreeScope, selectedTreeRow.path, false);
        } else if (selectedTreeRow.parentPath) {
          const parentKey = `${activeTreeScope.id}::${selectedTreeRow.parentPath}`;
          const parentRow = visibleTreeRows.find((row) => row.key === parentKey);
          if (parentRow) {
            selectAndPreviewTreeRow(activeTreeScope, parentRow, {
              scroll: true,
              focusButton: focusWasOnTreeRow,
            });
          }
        }
        return;
      }

      if ((event.key === "Enter" || (event.key === " " && !isTreeInput)) && focusInTreeList) {
        if (selectedTreeRow.kind === "directory") {
          event.preventDefault();
          event.stopPropagation();
          if (isTreeFiltered && event.key === "Enter") {
            clearTreeFilterAndReveal(selectedTreeRow);
          } else {
            toggleTreeDirectory(activeTreeScope, selectedTreeRow.path);
          }
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          selectAndPreviewTreeRow(activeTreeScope, selectedTreeRow);
          onFocusEditor();
        }
      }
      return;
    }

    if (isNext || isPrev) {
      if (navigableCandidates.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const currentIdx = navigableCandidates.findIndex(
        (item) => item.key === effectiveCandidateKey,
      );
      const delta = isNext ? 1 : -1;
      const nextIdx =
        currentIdx < 0
          ? 0
          : Math.max(0, Math.min(navigableCandidates.length - 1, currentIdx + delta));
      const nextCandidate = navigableCandidates[nextIdx];
      if (nextCandidate) {
        const targetEl = event.target instanceof HTMLElement ? event.target : null;
        const focusWasOnCandidate = Boolean(targetEl?.closest("[data-candidate-key]"));
        selectAndPreviewCandidate(nextCandidate, {
          scroll: true,
          focusButton: focusWasOnCandidate,
        });
      }
      return;
    }

    if (event.key === "Enter") {
      const targetEl = event.target instanceof HTMLElement ? event.target : null;
      const isInput = targetEl?.tagName === "INPUT";
      const isCandidateRow = Boolean(targetEl?.closest("[data-candidate-key]"));
      if (!isInput && !isCandidateRow) return;

      event.preventDefault();
      if (selectedCandidate) {
        selectAndPreviewCandidate(selectedCandidate);
        onFocusEditor();
      } else if (mode === "code" && isInput) {
        setTriggerNonce((n) => n + 1);
      }
    }
  };

  const toggleCollapsed = (key: string) => {
    setCollapsedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const startResize = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = { startX: event.clientX, startWidth: width };
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const current = draggingRef.current;
      if (!current) return;
      const nextWidth = Math.max(
        260,
        Math.min(760, current.startWidth + (moveEvent.clientX - current.startX)),
      );
      onWidthChange(nextWidth);
    };
    const handleUp = () => {
      draggingRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const showRepoBadgePerRow = scopes.length > 1;

  const renderTreeRows = (scope: ExplorerRepoScope): React.ReactNode => {
    if (isTreeFiltered) {
      if (treeSearch.isPending && visibleTreeRows.length === 0) {
        return (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            <span>
              <T>Filtering tree...</T>
            </span>
          </div>
        );
      }
      if (visibleTreeRows.length === 0) {
        return (
          <div className="py-8 text-center text-xs text-muted-foreground">
            <T>No matching folders or files.</T>
          </div>
        );
      }
    } else {
      const rootEntries = dirEntries[`${scope.id}::`];
      if (!rootEntries) {
        return (
          <div className="flex items-center gap-1.5 px-3 py-2 text-2xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            <span>
              <T>Loading...</T>
            </span>
          </div>
        );
      }
      if (rootEntries.length === 0) {
        return (
          <div className="px-3 py-2 text-2xs text-muted-foreground/70">
            <T>Empty folder</T>
          </div>
        );
      }
    }

    return visibleTreeRows.map((row) => {
      const isCursor = row.key === effectiveTreeKey;
      const isOpenedFile = row.kind === "file" && row.key === activeTabKey && !isCursor;
      const dimmed = row.ignored ? "opacity-55" : "";
      const displayLabel = isTreeFiltered
        ? renderHighlightedFileName(row.name, treeFilter)
        : row.name;

      if (row.kind === "directory") {
        return (
          <div key={row.key}>
            <button
              type="button"
              data-tree-key={row.key}
              style={{ paddingLeft: `${8 + row.depth * 12}px` }}
              onClick={() => {
                setSelectedTreeKey(row.key);
                toggleTreeDirectory(scope, row.path);
              }}
              className={[
                "flex w-full items-center gap-1 border-l-2 py-1 pr-2 text-left text-xs transition-colors outline-none",
                isCursor
                  ? "border-primary bg-primary/22 font-medium text-foreground ring-1 ring-inset ring-primary/35"
                  : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                dimmed,
              ].join(" ")}
            >
              {row.expanded ? (
                <ChevronDownIcon
                  className={["size-3.5 shrink-0", isCursor ? "text-primary" : "opacity-70"].join(
                    " ",
                  )}
                />
              ) : (
                <ChevronRightIcon
                  className={["size-3.5 shrink-0", isCursor ? "text-primary" : "opacity-70"].join(
                    " ",
                  )}
                />
              )}
              {row.expanded ? (
                <FolderOpenIcon className="size-3.5 shrink-0 text-warning" />
              ) : (
                <FolderIcon className="size-3.5 shrink-0 text-warning" />
              )}
              <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
            </button>
            {row.loadingChildren ? (
              <div
                style={{ paddingLeft: `${22 + (row.depth + 1) * 12}px` }}
                className="flex items-center gap-1.5 py-1 text-2xs text-muted-foreground"
              >
                <Loader2Icon className="size-3 animate-spin" />
                <span>
                  <T>Loading...</T>
                </span>
              </div>
            ) : row.emptyChildren ? (
              <div
                style={{ paddingLeft: `${22 + (row.depth + 1) * 12}px` }}
                className="py-1 text-2xs text-muted-foreground/70"
              >
                <T>Empty folder</T>
              </div>
            ) : null}
          </div>
        );
      }

      return (
        <button
          key={row.key}
          type="button"
          data-tree-key={row.key}
          style={{ paddingLeft: `${20 + row.depth * 12}px` }}
          onClick={() => selectAndPreviewTreeRow(scope, row)}
          className={[
            "flex w-full items-center gap-1.5 border-l-2 py-1 pr-2 text-left text-xs transition-colors outline-none",
            isCursor
              ? "border-primary bg-primary/22 font-medium text-foreground ring-1 ring-inset ring-primary/35"
              : isOpenedFile
                ? "border-primary/40 bg-muted/45 font-medium text-foreground"
                : "border-transparent text-foreground/85 hover:bg-muted/50",
            dimmed,
          ].join(" ")}
        >
          <FileIcon
            className={[
              "size-3.5 shrink-0",
              isCursor ? "text-primary" : "text-muted-foreground/70",
            ].join(" ")}
          />
          <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
        </button>
      );
    });
  };

  const footerFullPath =
    mode === "tree"
      ? selectedTreeRow && activeTreeScope
        ? `${activeTreeScope.name} / ${selectedTreeRow.path}`
        : null
      : (selectedCandidate?.fullPathLabel ?? null);

  return (
    <aside
      aria-label={gt("Code Explorer search")}
      style={{ width: `${width}px` }}
      data-code-explorer-escape-handled={isTreeFiltered ? "true" : undefined}
      onKeyDown={handleSidebarKeyDown}
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-background"
    >
      {/* Mode switcher: Code / Files / Tree */}
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border/70 px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant={mode === "code" ? "secondary" : "ghost-muted"}
            onClick={() => onModeChange("code")}
          >
            <SearchIcon className="size-3.5" />
            <span>
              <T>Code</T>
            </span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant={mode === "files" ? "secondary" : "ghost-muted"}
            onClick={() => onModeChange("files")}
          >
            <FileCode2Icon className="size-3.5" />
            <span>
              <T>Files</T>
            </span>
          </Button>
          <Button
            type="button"
            size="xs"
            variant={mode === "tree" ? "secondary" : "ghost-muted"}
            onClick={() => onModeChange("tree")}
          >
            <FolderTreeIcon className="size-3.5" />
            <span>
              <T>Tree</T>
            </span>
          </Button>
        </div>
        <kbd className="rounded border border-border/70 bg-muted/40 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          <T>Tab</T>
        </kbd>
      </div>

      {/* Search / filter inputs */}
      {mode !== "tree" ? (
        <div className="shrink-0 space-y-1.5 border-b border-border/60 p-2">
          <div className="relative flex items-center">
            <SearchIcon className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground/70" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedCandidateKey(null);
              }}
              placeholder={
                mode === "code"
                  ? gt("Search code in selected repos...")
                  : gt("Search files by name or path...")
              }
              aria-label={mode === "code" ? gt("Search code contents") : gt("Search files by name")}
              className="h-7 w-full rounded-md border border-border/80 bg-muted/25 pr-6 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary focus:bg-background"
            />
            {query ? (
              <button
                type="button"
                aria-label={gt("Clear search")}
                onClick={() => {
                  setQuery("");
                  setSelectedCandidateKey(null);
                }}
                className="absolute right-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            {mode === "code" ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant={caseSensitive ? "secondary" : "ghost-muted"}
                        aria-label={gt("Match case")}
                        onClick={() => setCaseSensitive((v) => !v)}
                      />
                    }
                  >
                    <CaseSensitiveIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    <T>Match case</T>
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant={wholeWord ? "secondary" : "ghost-muted"}
                        aria-label={gt("Match whole word")}
                        onClick={() => setWholeWord((v) => !v)}
                      />
                    }
                  >
                    <WholeWordIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    <T>Whole word</T>
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant={useRegex ? "secondary" : "ghost-muted"}
                        aria-label={gt("Use regular expression")}
                        onClick={() => setUseRegex((v) => !v)}
                      />
                    }
                  >
                    <RegexIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">
                    <T>Regular expression</T>
                  </TooltipPopup>
                </Tooltip>
              </>
            ) : null}
            <input
              type="text"
              value={pathFilter}
              onChange={(event) => {
                setPathFilter(event.target.value);
                setSelectedCandidateKey(null);
              }}
              placeholder={gt("Path filter (e.g. *.java, !*Test.java)")}
              aria-label={gt("Filter results by file path")}
              className="h-6 min-w-0 flex-1 rounded border border-border/70 bg-muted/20 px-2 font-mono text-3xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary focus:bg-background"
            />
          </div>

          {mode === "code" && query.trim() ? (
            <div className="flex items-center justify-between text-3xs text-muted-foreground">
              <span>
                {contentSearch.isPending
                  ? gt("Searching {count} repos...", { count: scopes.length })
                  : gt("{hits} matches in {repos} repos", {
                      hits: contentSearch.totalHits,
                      repos: contentSearch.groups.length,
                    })}
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="shrink-0 space-y-1.5 border-b border-border/60 p-2">
          {scopes.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {scopes.map((scope) => (
                <Button
                  key={scope.id}
                  type="button"
                  size="xs"
                  variant={activeTreeScope?.id === scope.id ? "secondary" : "ghost-muted"}
                  onClick={() => {
                    setTreeRepoId(scope.id);
                    setSelectedTreeKey(null);
                    setFilteredCollapsedDirs(new Set());
                    resultsContainerRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <span className="max-w-36 truncate">{scope.name}</span>
                </Button>
              ))}
            </div>
          ) : null}
          {activeTreeScope ? (
            <div className="relative flex items-center">
              <SearchIcon className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground/70" />
              <input
                ref={treeFilterInputRef}
                type="text"
                value={treeFilter}
                onChange={(event) => {
                  setTreeFilter(event.target.value);
                  setSelectedTreeKey(null);
                  setFilteredCollapsedDirs(new Set());
                }}
                placeholder={gt("Filter folders or files (or just type)...")}
                aria-label={gt("Filter repository tree")}
                className="h-7 w-full rounded-md border border-border/80 bg-muted/25 pr-14 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary focus:bg-background"
              />
              {isTreeFiltered && matchedTreeRows.length > 0 ? (
                <span className="pointer-events-none absolute right-6 font-mono text-3xs tabular-nums text-muted-foreground">
                  {activeTreeMatchIndex >= 0 ? activeTreeMatchIndex + 1 : 1}/
                  {matchedTreeRows.length}
                </span>
              ) : null}
              {treeFilter ? (
                <button
                  type="button"
                  aria-label={gt("Clear tree filter and reveal in full tree")}
                  onClick={() => clearTreeFilterAndReveal(selectedTreeRow)}
                  className="absolute right-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* Results area */}
      <div
        ref={resultsContainerRef}
        tabIndex={mode === "tree" ? 0 : undefined}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
      >
        {scopes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
            <p>
              <T>Select one or more repositories above to start searching.</T>
            </p>
          </div>
        ) : mode === "code" ? (
          !query.trim() ? (
            <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center text-xs text-muted-foreground">
              <p>
                <T>Type a symbol, method name, or keyword to search across selected repos.</T>
              </p>
              <p className="text-3xs text-muted-foreground/75">
                <T>
                  Tip: Use Up/Down arrows to preview matches; Cmd+Click / Cmd+B jumps to
                  definitions; Option+F7 finds usages.
                </T>
              </p>
            </div>
          ) : contentSearch.error ? (
            <div className="p-3 text-xs text-error">{contentSearch.error}</div>
          ) : contentSearch.isPending && contentSearch.groups.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              <span>
                <T>Searching...</T>
              </span>
            </div>
          ) : contentSearch.groups.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              <T>No matching lines found.</T>
            </div>
          ) : (
            contentSearch.groups.map((repoGroup) => {
              const repoCollapsed = collapsedKeys.has(`repo:${repoGroup.repoId}`);
              return (
                <div key={repoGroup.repoId} className="mb-1">
                  <button
                    type="button"
                    onClick={() => toggleCollapsed(`repo:${repoGroup.repoId}`)}
                    className="flex w-full items-center gap-1 bg-muted/25 px-2 py-1 text-left text-2xs font-semibold text-foreground hover:bg-muted/50"
                  >
                    {repoCollapsed ? (
                      <ChevronRightIcon className="size-3.5 shrink-0 opacity-70" />
                    ) : (
                      <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{repoGroup.repoName}</span>
                    <span className="font-mono text-3xs tabular-nums text-muted-foreground">
                      {repoGroup.totalHits}
                      {repoGroup.truncated ? "+" : ""}
                    </span>
                  </button>

                  {!repoCollapsed
                    ? repoGroup.files.map((fileGroup) => {
                        const fileCollapsed = collapsedKeys.has(`file:${fileGroup.key}`);
                        const fileName = basenameOfPath(fileGroup.relativePath);
                        const compactParent = formatCompactParentPath(fileGroup.relativePath);
                        const isTest = isTestFilePath(fileGroup.relativePath);
                        return (
                          <div key={fileGroup.key}>
                            <button
                              type="button"
                              onClick={() => toggleCollapsed(`file:${fileGroup.key}`)}
                              className="flex w-full items-center gap-1.5 py-1 pr-2 pl-3.5 text-left text-xs text-foreground/95 hover:bg-muted/40"
                            >
                              {fileCollapsed ? (
                                <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
                              ) : (
                                <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
                              )}
                              <FileIcon className="size-3 shrink-0 text-muted-foreground/75" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="min-w-0 truncate text-2xs font-medium text-foreground">
                                    {fileName}
                                  </span>
                                  {isTest ? (
                                    <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-3xs text-muted-foreground">
                                      <T>test</T>
                                    </span>
                                  ) : null}
                                </div>
                                {compactParent ? (
                                  <div className="truncate font-mono text-3xs text-muted-foreground/70">
                                    {compactParent}
                                  </div>
                                ) : null}
                              </div>
                              <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">
                                {fileGroup.hits.length}
                              </span>
                            </button>

                            {!fileCollapsed
                              ? fileGroup.hits.map((hit) => {
                                  const hitKey = codeHitCandidateKey(
                                    hit.repoId,
                                    hit.relativePath,
                                    hit.lineNumber,
                                  );
                                  const isSelected = hitKey === effectiveCandidateKey;
                                  return (
                                    <button
                                      key={hitKey}
                                      data-candidate-key={hitKey}
                                      type="button"
                                      onClick={() =>
                                        selectAndPreviewCandidate({
                                          key: hitKey,
                                          target: {
                                            repoId: hit.repoId,
                                            repoName: hit.repoName,
                                            cwd: hit.cwd,
                                            environmentId: hit.environmentId,
                                            relativePath: hit.relativePath,
                                            lineNumber: hit.lineNumber,
                                            column: (hit.matchRanges[0]?.start ?? 0) + 1,
                                          },
                                          fullPathLabel: `${hit.repoName} / ${hit.relativePath}:${hit.lineNumber}`,
                                        })
                                      }
                                      className={[
                                        "flex w-full items-baseline gap-2 border-l-2 py-0.5 pr-2 pl-7 text-left font-mono text-2xs transition-colors",
                                        isSelected
                                          ? "border-primary bg-primary/22 font-medium text-foreground ring-1 ring-inset ring-primary/35"
                                          : "border-transparent text-foreground/85 hover:bg-muted/50",
                                      ].join(" ")}
                                    >
                                      <span
                                        className={[
                                          "w-8 shrink-0 text-right tabular-nums",
                                          isSelected
                                            ? "font-semibold text-primary"
                                            : "text-muted-foreground/70",
                                        ].join(" ")}
                                      >
                                        {hit.lineNumber}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate">
                                        {renderHighlightedLine(hit)}
                                      </span>
                                    </button>
                                  );
                                })
                              : null}
                          </div>
                        );
                      })
                    : null}
                </div>
              );
            })
          )
        ) : mode === "files" ? (
          fileSearch.isPending && fileSearch.files.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2Icon className="size-3.5 animate-spin" />
              <span>
                <T>Searching files...</T>
              </span>
            </div>
          ) : fileSearch.files.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              <T>No matching files found.</T>
            </div>
          ) : (
            fileSearch.files.map((file) => {
              const isSelected = file.key === effectiveCandidateKey;
              const compactParent = formatCompactParentPath(file.relativePath);
              const isTest = isTestFilePath(file.relativePath);
              return (
                <button
                  key={file.key}
                  data-candidate-key={file.key}
                  type="button"
                  onClick={() =>
                    selectAndPreviewCandidate({
                      key: file.key,
                      target: {
                        repoId: file.repoId,
                        repoName: file.repoName,
                        cwd: file.cwd,
                        environmentId: file.environmentId,
                        relativePath: file.relativePath,
                      },
                      fullPathLabel: `${file.repoName} / ${file.relativePath}`,
                    })
                  }
                  className={[
                    "flex w-full items-start gap-2 border-l-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                    isSelected
                      ? "border-primary bg-primary/22 font-medium text-foreground ring-1 ring-inset ring-primary/35"
                      : "border-transparent text-foreground/90 hover:bg-muted/50",
                  ].join(" ")}
                >
                  <FileIcon
                    className={[
                      "mt-0.5 size-3.5 shrink-0",
                      isSelected ? "text-primary" : "text-muted-foreground/70",
                    ].join(" ")}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate leading-tight">
                        {renderHighlightedFileName(file.fileName, query)}
                      </span>
                      {isTest ? (
                        <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-3xs text-muted-foreground">
                          <T>test</T>
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      {showRepoBadgePerRow ? (
                        <span className="max-w-28 shrink-0 truncate rounded bg-muted px-1 py-px font-mono text-3xs text-muted-foreground">
                          {file.repoName}
                        </span>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate font-mono text-3xs leading-tight text-muted-foreground/75">
                        {compactParent || file.relativePath}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })
          )
        ) : activeTreeScope ? (
          renderTreeRows(activeTreeScope)
        ) : null}
      </div>

      {/* IDEA-style full path footer bar for currently focused candidate or tree node */}
      {footerFullPath ? (
        <div className="shrink-0 truncate border-t border-border/70 bg-muted/20 px-2.5 py-1 font-mono text-3xs text-muted-foreground">
          {footerFullPath}
        </div>
      ) : null}

      {/* Drag resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={gt("Resize search sidebar")}
        onMouseDown={startResize}
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-primary/40"
      />
    </aside>
  );
}
