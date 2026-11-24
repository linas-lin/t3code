import { T, useGT } from "gt-react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FileIcon,
  FlaskConicalOffIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  ListIcon,
  MessageSquareIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import { DiffStatLabel } from "../../chat/DiffStatLabel";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import {
  buildCompactIdeDiffTree,
  flattenTreeFileEntries,
  type IdeDiffTreeFolderNode,
  type IdeDiffTreeNode,
} from "./ideDiffTree.logic";
import type { IdeDiffFileEntry, IdeDiffFileStatus, IdeDiffTreeViewMode } from "./types";

export interface IdeDiffFileTreeProps {
  readonly entries: ReadonlyArray<IdeDiffFileEntry>;
  readonly allEntriesCount: number;
  readonly viewedCount: number;
  readonly selectedFileKey: string | null;
  readonly onSelectEntry: (entry: IdeDiffFileEntry) => void;
  readonly isViewed: (entry: IdeDiffFileEntry) => boolean;
  readonly onToggleViewed: (entry: IdeDiffFileEntry) => void;
  readonly getCommentCount?: ((entry: IdeDiffFileEntry) => number) | undefined;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly treeViewMode: IdeDiffTreeViewMode;
  readonly onTreeViewModeChange: (mode: IdeDiffTreeViewMode) => void;
  readonly hideViewed: boolean;
  readonly onHideViewedChange: (hide: boolean) => void;
  readonly hideTests: boolean;
  readonly onHideTestsChange?: ((hide: boolean) => void) | undefined;
  readonly testFileCount: number;
  readonly width: number;
  readonly onWidthChange: (width: number) => void;
  readonly onFileContextMenu?:
    | ((entry: IdeDiffFileEntry, event: MouseEvent<HTMLElement>) => void)
    | undefined;
}

const STATUS_BADGE: Record<
  IdeDiffFileStatus,
  { readonly letter: string; readonly className: string }
> = {
  modified: { letter: "M", className: "text-info" },
  added: { letter: "A", className: "text-diff-addition-foreground" },
  deleted: { letter: "D", className: "text-diff-deletion-foreground" },
  renamed: { letter: "R", className: "text-guest" },
  copied: { letter: "C", className: "text-primary" },
};

function splitDirAndFile(path: string): { readonly dir: string; readonly name: string } {
  const normalized = path.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return { dir: "", name: normalized };
  return { dir: normalized.slice(0, idx), name: normalized.slice(idx + 1) };
}

export function IdeDiffFileTree({
  entries,
  allEntriesCount,
  viewedCount,
  selectedFileKey,
  onSelectEntry,
  isViewed,
  onToggleViewed,
  getCommentCount,
  query,
  onQueryChange,
  treeViewMode,
  onTreeViewModeChange,
  hideViewed,
  onHideViewedChange,
  hideTests,
  onHideTestsChange,
  testFileCount,
  width,
  onWidthChange,
  onFileContextMenu,
}: IdeDiffFileTreeProps) {
  const gt = useGT();
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const treeNodes = treeViewMode === "tree" ? buildCompactIdeDiffTree(entries) : [];

  const orderedVisibleEntries =
    treeViewMode === "tree" ? flattenTreeFileEntries(treeNodes) : entries;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the newly selected file item into view in the sidebar tree
  useEffect(() => {
    if (!selectedFileKey || !listRef.current) return;
    const escaped = selectedFileKey.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const el = listRef.current.querySelector<HTMLElement>(`[data-ide-file-key="${escaped}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedFileKey]);

  const startResize = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    draggingRef.current = { startX: event.clientX, startWidth: width };
    const handleMove = (moveEvent: globalThis.MouseEvent) => {
      const current = draggingRef.current;
      if (!current) return;
      onWidthChange(current.startWidth + (moveEvent.clientX - current.startX));
    };
    const handleUp = () => {
      draggingRef.current = null;
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const toggleFolder = (folderId: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const progressPct =
    allEntriesCount > 0 ? Math.min(100, Math.round((viewedCount / allEntriesCount) * 100)) : 0;

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (orderedVisibleEntries.length === 0) return;
    event.preventDefault();
    const currentIndex = orderedVisibleEntries.findIndex(
      (item) => item.fileKey === selectedFileKey,
    );
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      currentIndex < 0
        ? 0
        : (currentIndex + delta + orderedVisibleEntries.length) % orderedVisibleEntries.length;
    const target = orderedVisibleEntries[nextIndex];
    if (target) onSelectEntry(target);
  };

  const renderFileRow = (entry: IdeDiffFileEntry, displayName: string, depth: number) => {
    const selected = entry.fileKey === selectedFileKey;
    const viewed = isViewed(entry);
    const badge = STATUS_BADGE[entry.status];
    const commentCount = getCommentCount ? getCommentCount(entry) : 0;
    const { dir } = splitDirAndFile(entry.path);
    const tooltipPath = entry.previousPath ? `${entry.previousPath} → ${entry.path}` : entry.path;

    return (
      <div
        key={entry.fileKey}
        data-ide-file-key={entry.fileKey}
        role="treeitem"
        aria-selected={selected}
        aria-label={tooltipPath}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelectEntry(entry)}
        onContextMenu={(event) => onFileContextMenu?.(entry, event)}
        className={[
          "group flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-xs select-none transition-colors",
          selected
            ? "bg-primary/14 text-foreground font-medium"
            : "text-foreground/85 hover:bg-muted/60",
          viewed && !selected ? "opacity-55" : "",
        ].join(" ")}
      >
        <button
          type="button"
          aria-label={
            viewed
              ? gt("Mark {path} as unviewed", { path: entry.path })
              : gt("Mark {path} as viewed", { path: entry.path })
          }
          onClick={(event) => {
            event.stopPropagation();
            onToggleViewed(entry);
          }}
          className={[
            "flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors",
            viewed
              ? "border-success/70 bg-success/20 text-success"
              : "border-border/80 bg-transparent text-transparent opacity-40 group-hover:opacity-100 hover:border-foreground/50",
          ].join(" ")}
        >
          <CheckIcon className="size-2.5" />
        </button>

        <span
          aria-hidden="true"
          className={`w-3 shrink-0 text-center font-mono text-2xs font-semibold ${badge.className}`}
        >
          {badge.letter}
        </span>

        <FileIcon className="size-3.5 shrink-0 text-muted-foreground/70" />

        <div className="min-w-0 flex-1">
          <div className="truncate leading-tight">{displayName}</div>
          {treeViewMode === "flat" && dir ? (
            <div className="truncate text-3xs leading-tight text-muted-foreground/75">{dir}</div>
          ) : null}
        </div>

        {commentCount > 0 ? (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/15 px-1 py-0.5 font-mono text-3xs text-primary"
            aria-label={gt("{count} review comments", { count: commentCount })}
          >
            <MessageSquareIcon className="size-2.5" />
            {commentCount}
          </span>
        ) : null}

        <DiffStatLabel
          additions={entry.additions}
          deletions={entry.deletions}
          layout="inline"
          className="shrink-0 text-3xs"
        />
      </div>
    );
  };

  const renderNode = (node: IdeDiffTreeNode, depth: number): React.ReactNode => {
    if (node.kind === "file") {
      return renderFileRow(node.entry, node.name, depth);
    }
    const folder: IdeDiffTreeFolderNode = node;
    const isCollapsed = collapsedFolders.has(folder.id);
    return (
      <div key={folder.id} role="group">
        <div
          role="treeitem"
          aria-expanded={!isCollapsed}
          aria-label={folder.fullPath}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          onClick={() => toggleFolder(folder.id)}
          className="flex cursor-pointer items-center gap-1 py-1 pr-2 text-xs text-muted-foreground select-none hover:bg-muted/50 hover:text-foreground"
        >
          {isCollapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0 opacity-70" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          )}
          {isCollapsed ? (
            <FolderIcon className="size-3.5 shrink-0 text-warning" />
          ) : (
            <FolderOpenIcon className="size-3.5 shrink-0 text-warning" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
          <span className="shrink-0 font-mono text-3xs text-muted-foreground/70">
            {folder.fileCount}
          </span>
        </div>
        {!isCollapsed ? folder.children.map((child) => renderNode(child, depth + 1)) : null}
      </div>
    );
  };

  return (
    <aside
      aria-label={gt("Changed files")}
      style={{ width: `${width}px` }}
      className="relative flex h-full shrink-0 flex-col border-r border-border/70 bg-background"
    >
      {/* Search + filter bar */}
      <div className="shrink-0 space-y-1.5 border-b border-border/60 p-2">
        <div className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground/70" />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={gt("Filter files...")}
            aria-label={gt("Filter changed files")}
            className="h-7 w-full rounded-md border border-border/70 bg-muted/30 pr-6 pl-7 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/60 focus:bg-background"
          />
          {query ? (
            <button
              type="button"
              aria-label={gt("Clear filter")}
              onClick={() => onQueryChange("")}
              className="absolute right-1.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={treeViewMode === "tree" ? "secondary" : "ghost-muted"}
                    aria-label={gt("Tree view")}
                    onClick={() => onTreeViewModeChange("tree")}
                  />
                }
              >
                <FolderTreeIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <T>Tree view (compact folders)</T>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={treeViewMode === "flat" ? "secondary" : "ghost-muted"}
                    aria-label={gt("Flat list view")}
                    onClick={() => onTreeViewModeChange("flat")}
                  />
                }
              >
                <ListIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                <T>Flat list</T>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant={hideViewed ? "secondary" : "ghost-muted"}
                    aria-label={hideViewed ? gt("Show viewed files") : gt("Hide viewed files")}
                    onClick={() => onHideViewedChange(!hideViewed)}
                  />
                }
              >
                <EyeOffIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {hideViewed ? gt("Show viewed files") : gt("Hide viewed files")}
              </TooltipPopup>
            </Tooltip>
            {testFileCount > 0 && onHideTestsChange ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant={hideTests ? "secondary" : "ghost-muted"}
                      aria-label={hideTests ? gt("Show test files") : gt("Hide test files")}
                      onClick={() => onHideTestsChange(!hideTests)}
                    />
                  }
                >
                  <FlaskConicalOffIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  {hideTests
                    ? gt("Show {count} hidden test files", { count: testFileCount })
                    : gt("Hide test files")}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>

          <span className="font-mono text-3xs tabular-nums text-muted-foreground">
            {gt("{viewed}/{total} viewed", { viewed: viewedCount, total: allEntriesCount })}
          </span>
        </div>

        {/* Review progress bar */}
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-success transition-all duration-200"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Tree / Flat file list */}
      <div
        ref={listRef}
        role="tree"
        tabIndex={0}
        onKeyDown={handleListKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
      >
        {entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
            <span>
              {query || hideViewed || hideTests ? (
                <T>No files match the current filter.</T>
              ) : (
                <T>No changed files.</T>
              )}
            </span>
            {query || hideViewed ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  onQueryChange("");
                  onHideViewedChange(false);
                }}
              >
                <T>Reset filters</T>
              </Button>
            ) : null}
          </div>
        ) : treeViewMode === "tree" ? (
          treeNodes.map((node) => renderNode(node, 0))
        ) : (
          entries.map((entry) => renderFileRow(entry, splitDirAndFile(entry.path).name, 0))
        )}
      </div>

      {/* Drag resize handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={gt("Resize file tree")}
        onMouseDown={startResize}
        className="absolute top-0 right-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-primary/40"
      />
    </aside>
  );
}
