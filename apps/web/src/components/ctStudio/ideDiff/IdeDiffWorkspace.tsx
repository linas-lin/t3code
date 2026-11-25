import { T, useGT } from "gt-react";
import { SendHorizontalIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { useDesktopOverlayHeaderChrome } from "../useDesktopOverlayHeaderChrome";
import { IdeDiffFileTree } from "./IdeDiffFileTree";
import {
  resolveEffectiveDiffLayout,
  useIdeDiffPreferences,
  useIdeDiffViewedFiles,
} from "./ideDiffPreferences";
import { IdeDiffToolbar } from "./IdeDiffToolbar";
import {
  buildCompactIdeDiffTree,
  filterIdeDiffEntries,
  findNextUnviewedEntry,
  flattenTreeFileEntries,
} from "./ideDiffTree.logic";
import { MonacoDiffViewport } from "./MonacoDiffViewport";
import type {
  IdeDiffAnnotationAdapter,
  IdeDiffChangeNavigationState,
  IdeDiffContentProvider,
  IdeDiffEditAdapter,
  IdeDiffFileEntry,
  IdeDiffOpenFileTarget,
  IdeDiffViewMode,
  IdeDiffViewportHandle,
} from "./types";

export interface IdeDiffWorkspaceProps {
  readonly scopeKey: string;
  readonly scopeTitle?: string | undefined;
  readonly entries: ReadonlyArray<IdeDiffFileEntry>;
  readonly selectedFilePath?: string | null | undefined;
  readonly onSelectFilePath?: (filePath: string) => void;
  readonly contentProvider: IdeDiffContentProvider;
  readonly annotationAdapter?: IdeDiffAnnotationAdapter | undefined;
  readonly editAdapter?: IdeDiffEditAdapter | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly diffLayout: IdeDiffViewMode;
  readonly onDiffLayoutChange: (layout: IdeDiffViewMode) => void;
  readonly ignoreWhitespace: boolean;
  readonly onIgnoreWhitespaceChange: (ignore: boolean) => void;
  readonly wordWrap: boolean;
  readonly onWordWrapChange: (wrap: boolean) => void;
  readonly hideTestFiles?: boolean | undefined;
  readonly onHideTestFilesChange?: ((hide: boolean) => void) | undefined;
  readonly testFileCount?: number | undefined;
  readonly onOpenExternal?: ((target: IdeDiffOpenFileTarget) => void) | undefined;
  readonly onFileContextMenu?:
    | ((entry: IdeDiffFileEntry, event: MouseEvent<HTMLElement>) => void)
    | undefined;
  readonly onSwitchToClassic?: (() => void) | undefined;
  readonly pendingCommentCount?: number | undefined;
  readonly onFocusComposer?: (() => void) | undefined;
  readonly banner?: ReactNode;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.closest("[data-diff-comment-annotation], .find-widget"));
}

export function IdeDiffWorkspace({
  scopeKey,
  scopeTitle,
  entries,
  selectedFilePath,
  onSelectFilePath,
  contentProvider,
  annotationAdapter,
  editAdapter,
  resolvedTheme,
  diffLayout,
  onDiffLayoutChange,
  ignoreWhitespace,
  onIgnoreWhitespaceChange,
  wordWrap,
  onWordWrapChange,
  hideTestFiles = false,
  onHideTestFilesChange,
  testFileCount = 0,
  onOpenExternal,
  onFileContextMenu,
  onSwitchToClassic,
  pendingCommentCount = 0,
  onFocusComposer,
  banner,
}: IdeDiffWorkspaceProps) {
  const gt = useGT();
  const { headerClassName: desktopHeaderClassName, headerStyle: desktopHeaderStyle } =
    useDesktopOverlayHeaderChrome();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<IdeDiffViewportHandle | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [narrowTreeOverride, setNarrowTreeOverride] = useState<boolean | null>(null);
  const [narrowLayoutOverride, setNarrowLayoutOverride] = useState<IdeDiffViewMode | null>(null);
  const [query, setQuery] = useState("");
  const [selectedState, setSelectedState] = useState<{
    readonly fileKey: string | null;
    readonly externalPath: string | null | undefined;
  }>({ fileKey: null, externalPath: selectedFilePath });
  const [changeNav, setChangeNav] = useState<IdeDiffChangeNavigationState>({
    currentIndex: -1,
    totalCount: 0,
  });

  const {
    preferences,
    setTreeViewMode,
    setCollapseUnchanged,
    setHideViewed,
    setTreeOpen,
    setTreeWidth,
  } = useIdeDiffPreferences();

  const { isViewed, toggleViewed, setViewed, viewedCountFor } = useIdeDiffViewedFiles(scopeKey);

  // Measure container width for responsive narrow-pane adaptation.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to observeResize to adapt layout for narrow sidebars
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    return observeResize(element, (records) => {
      const width = records[0]?.contentRect.width ?? element.clientWidth;
      setContainerWidth(Math.round(width));
    });
  }, []);

  const layoutDecision = resolveEffectiveDiffLayout({
    containerWidth,
    fullscreen,
    userLayout: diffLayout,
    userTreeOpen: preferences.treeOpen,
  });

  const effectiveTreeOpen = layoutDecision.isNarrow
    ? (narrowTreeOverride ?? layoutDecision.effectiveTreeOpen)
    : layoutDecision.effectiveTreeOpen;

  const effectiveViewMode = layoutDecision.isNarrow
    ? (narrowLayoutOverride ?? layoutDecision.effectiveLayout)
    : layoutDecision.effectiveLayout;

  // Derive activeFileKey, honoring new external selectedFilePath updates without an effect.
  const externalMatchedKey =
    selectedFilePath && selectedFilePath !== selectedState.externalPath
      ? (entries.find((item) => item.path === selectedFilePath)?.fileKey ?? null)
      : null;
  const activeFileKey = externalMatchedKey ?? selectedState.fileKey;

  const filteredEntries = filterIdeDiffEntries(entries, {
    query,
    hideViewed: preferences.hideViewed,
    hideTests: hideTestFiles,
    isViewed,
    keepFileKey: activeFileKey,
  });

  const navigationOrder =
    preferences.treeViewMode === "flat"
      ? filteredEntries
      : flattenTreeFileEntries(buildCompactIdeDiffTree(filteredEntries));

  const activeEntry = (() => {
    if (navigationOrder.length === 0) return null;
    if (activeFileKey) {
      const found = navigationOrder.find((item) => item.fileKey === activeFileKey);
      if (found) return found;
    }
    return navigationOrder[0] ?? null;
  })();

  const activeIndex = activeEntry
    ? navigationOrder.findIndex((item) => item.fileKey === activeEntry.fileKey)
    : -1;

  const selectEntry = (entry: IdeDiffFileEntry) => {
    setSelectedState({ fileKey: entry.fileKey, externalPath: selectedFilePath });
    onSelectFilePath?.(entry.path);
  };

  const stepFile = (delta: number) => {
    if (navigationOrder.length <= 1) return;
    const start = activeIndex >= 0 ? activeIndex : 0;
    const nextIdx = (start + delta + navigationOrder.length) % navigationOrder.length;
    const target = navigationOrder[nextIdx];
    if (target) selectEntry(target);
  };

  const handleNextChange = () => {
    const moved = viewportRef.current?.goToNextChange() ?? false;
    if (!moved && navigationOrder.length > 1) {
      stepFile(1);
    }
  };

  const handlePrevChange = () => {
    const moved = viewportRef.current?.goToPreviousChange() ?? false;
    if (!moved && navigationOrder.length > 1) {
      stepFile(-1);
    }
  };

  const handleMarkViewedAndNext = () => {
    if (!activeEntry) return;
    setViewed(activeEntry, true);
    const next = findNextUnviewedEntry(navigationOrder, activeEntry.fileKey, (item) =>
      item.fileKey === activeEntry.fileKey ? true : isViewed(item),
    );
    if (next) selectEntry(next);
  };

  const handleToggleTree = () => {
    if (layoutDecision.isNarrow) {
      setNarrowTreeOverride(!effectiveTreeOpen);
    } else {
      setTreeOpen(!preferences.treeOpen);
    }
  };

  const handleViewModeChange = (mode: IdeDiffViewMode) => {
    if (layoutDecision.isNarrow) {
      setNarrowLayoutOverride(mode);
    } else {
      onDiffLayoutChange(mode);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && fullscreen && !isEditableKeyboardTarget(event.target)) {
      event.preventDefault();
      setFullscreen(false);
      return;
    }

    // IDEA navigation shortcuts work even when focus is inside the read-only Monaco editor.
    if (event.key === "F7") {
      event.preventDefault();
      if (event.shiftKey) handlePrevChange();
      else handleNextChange();
      return;
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        handleNextChange();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        handlePrevChange();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        stepFile(1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepFile(-1);
        return;
      }
    }

    if (isEditableKeyboardTarget(event.target)) return;

    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === "v") {
        if (activeEntry) {
          event.preventDefault();
          toggleViewed(activeEntry);
        }
        return;
      }
      if (event.key === "V" && event.shiftKey) {
        if (activeEntry) {
          event.preventDefault();
          handleMarkViewedAndNext();
        }
      }
    }
  };

  const viewedCount = viewedCountFor(entries);
  const getCommentCount = annotationAdapter
    ? (entry: IdeDiffFileEntry) => annotationAdapter.getAnnotations(entry).length
    : undefined;

  const handleReturnToComposer = () => {
    setFullscreen(false);
    onFocusComposer?.();
  };

  const workspaceBody = (
    <div
      data-ide-diff-workspace
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none"
    >
      {fullscreen ? (
        <div
          style={desktopHeaderStyle}
          className={cn(
            "flex h-[var(--workspace-topbar-height)] min-h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3",
            desktopHeaderClassName,
          )}
        >
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
            <span className="truncate">{scopeTitle ?? gt("IDE Diff Review")}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
              {gt("{viewed}/{total} viewed", { viewed: viewedCount, total: entries.length })}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {pendingCommentCount > 0 && onFocusComposer ? (
              <Button type="button" size="xs" variant="default" onClick={handleReturnToComposer}>
                <SendHorizontalIcon className="size-3.5" />
                <span>{gt("Go to chat ({count} comments)", { count: pendingCommentCount })}</span>
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              aria-label={gt("Exit fullscreen review")}
              onClick={() => setFullscreen(false)}
            >
              <XIcon className="size-3.5" />
              <span>
                <T>Close</T>
              </span>
            </Button>
          </div>
        </div>
      ) : null}

      {banner}

      <IdeDiffToolbar
        entry={activeEntry}
        fileIndex={activeIndex}
        fileCount={navigationOrder.length}
        viewed={activeEntry ? isViewed(activeEntry) : false}
        onToggleViewed={() => {
          if (activeEntry) toggleViewed(activeEntry);
        }}
        onMarkViewedAndNext={handleMarkViewedAndNext}
        changeNav={changeNav}
        onPrevChange={handlePrevChange}
        onNextChange={handleNextChange}
        onPrevFile={() => stepFile(-1)}
        onNextFile={() => stepFile(1)}
        treeOpen={effectiveTreeOpen}
        onToggleTree={handleToggleTree}
        viewMode={effectiveViewMode}
        onViewModeChange={handleViewModeChange}
        collapseUnchanged={preferences.collapseUnchanged}
        onCollapseUnchangedChange={setCollapseUnchanged}
        ignoreWhitespace={ignoreWhitespace}
        onIgnoreWhitespaceChange={onIgnoreWhitespaceChange}
        wordWrap={wordWrap}
        onWordWrapChange={onWordWrapChange}
        onFocusFind={() => viewportRef.current?.focusFind()}
        {...(onOpenExternal && activeEntry
          ? {
              onOpenExternal: () =>
                onOpenExternal({
                  entry: activeEntry,
                  lineNumber: viewportRef.current?.getCurrentLineNumber() ?? undefined,
                }),
            }
          : {})}
        fullscreen={fullscreen}
        onToggleFullscreen={() => setFullscreen((current) => !current)}
        onSwitchToClassic={onSwitchToClassic}
        pendingCommentCount={pendingCommentCount}
        onFocusComposer={onFocusComposer ? handleReturnToComposer : undefined}
        isNarrow={layoutDecision.isNarrow}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {effectiveTreeOpen ? (
          <IdeDiffFileTree
            entries={filteredEntries}
            allEntriesCount={entries.length}
            viewedCount={viewedCount}
            selectedFileKey={activeEntry?.fileKey ?? null}
            onSelectEntry={selectEntry}
            isViewed={isViewed}
            onToggleViewed={toggleViewed}
            getCommentCount={getCommentCount}
            query={query}
            onQueryChange={setQuery}
            treeViewMode={preferences.treeViewMode}
            onTreeViewModeChange={setTreeViewMode}
            hideViewed={preferences.hideViewed}
            onHideViewedChange={setHideViewed}
            hideTests={hideTestFiles}
            onHideTestsChange={onHideTestFilesChange}
            testFileCount={testFileCount}
            width={preferences.treeWidth}
            onWidthChange={setTreeWidth}
            onFileContextMenu={onFileContextMenu}
          />
        ) : null}

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {entries.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
              <T>No changed files in this selection.</T>
            </div>
          ) : (
            <MonacoDiffViewport
              ref={viewportRef}
              entry={activeEntry}
              contentProvider={contentProvider}
              annotationAdapter={annotationAdapter}
              editAdapter={editAdapter}
              viewMode={effectiveViewMode}
              resolvedTheme={resolvedTheme}
              collapseUnchanged={preferences.collapseUnchanged}
              ignoreWhitespace={ignoreWhitespace}
              wordWrap={wordWrap}
              onChangeNavigationUpdate={setChangeNav}
              onOpenExternal={onOpenExternal}
            />
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {fullscreen && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label={scopeTitle ?? gt("IDE Diff Review")}
              className="fixed inset-0 z-50 flex flex-col bg-background"
            >
              {workspaceBody}
            </div>,
            document.body,
          )
        : workspaceBody}
    </div>
  );
}
