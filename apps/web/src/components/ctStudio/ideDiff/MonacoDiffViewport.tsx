import { T, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  FileWarningIcon,
  ImageIcon,
  InfoIcon,
  RefreshCwIcon,
  SaveIcon,
} from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "../../ui/button";
import { DiffConnectorOverlay } from "./DiffConnectorOverlay";
import { MonacoAnnotationLayer } from "./MonacoAnnotationLayer";
import { syncMonacoTheme } from "./monacoTheme";
import { ensureMonacoInitialized, monaco } from "./monacoWorkers";
import type {
  IdeDiffAnnotationAdapter,
  IdeDiffChangeNavigationState,
  IdeDiffContentProvider,
  IdeDiffEditAdapter,
  IdeDiffFileEntry,
  IdeDiffHunkChange,
  IdeDiffLoadedContent,
  IdeDiffOpenFileTarget,
  IdeDiffViewMode,
  IdeDiffViewportHandle,
} from "./types";

const MAX_CONTENT_CACHE_ENTRIES = 16;

export interface MonacoDiffViewportProps {
  readonly entry: IdeDiffFileEntry | null;
  readonly contentProvider: IdeDiffContentProvider;
  readonly annotationAdapter?: IdeDiffAnnotationAdapter | undefined;
  readonly editAdapter?: IdeDiffEditAdapter | undefined;
  readonly viewMode: IdeDiffViewMode;
  readonly resolvedTheme: "light" | "dark";
  readonly collapseUnchanged: boolean;
  readonly ignoreWhitespace: boolean;
  readonly wordWrap: boolean;
  readonly onChangeNavigationUpdate?: ((state: IdeDiffChangeNavigationState) => void) | undefined;
  readonly onOpenExternal?: ((target: IdeDiffOpenFileTarget) => void) | undefined;
  readonly ref?: Ref<IdeDiffViewportHandle>;
}

const FALLBACK_MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

function readMonoFontFamily(): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return FALLBACK_MONO_FONT;
  }
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim();
  return value || FALLBACK_MONO_FONT;
}

function toHunkChanges(
  raw: ReadonlyArray<monaco.editor.ILineChange> | null,
): ReadonlyArray<IdeDiffHunkChange> {
  if (!raw) return [];
  return raw.map((item) => ({
    originalStartLineNumber: item.originalStartLineNumber,
    originalEndLineNumber: item.originalEndLineNumber,
    modifiedStartLineNumber: item.modifiedStartLineNumber,
    modifiedEndLineNumber: item.modifiedEndLineNumber,
  }));
}

export function MonacoDiffViewport({
  entry,
  contentProvider,
  annotationAdapter,
  editAdapter,
  viewMode,
  resolvedTheme,
  collapseUnchanged,
  ignoreWhitespace,
  wordWrap,
  onChangeNavigationUpdate,
  onOpenExternal,
  ref,
}: MonacoDiffViewportProps) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [diffEditorInstance, setDiffEditorInstance] =
    useState<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  const contentCacheRef = useRef<{
    scopeKey: string;
    items: Map<string, IdeDiffLoadedContent>;
  }>({ scopeKey: "", items: new Map() });
  const changesRef = useRef<ReadonlyArray<IdeDiffHunkChange>>([]);
  const activeChangeIndexRef = useRef<number>(-1);

  const [loadedRecord, setLoadedRecord] = useState<{
    readonly requestKey: string;
    readonly content: IdeDiffLoadedContent;
  } | null>(null);
  const [retryCounter, setRetryCounter] = useState(0);
  const [changes, setChanges] = useState<ReadonlyArray<IdeDiffHunkChange>>([]);
  const [activeChangeIndex, setActiveChangeIndex] = useState(-1);
  const [dirtyFileKey, setDirtyFileKey] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const notifyChangeNav = useStableCallback((state: IdeDiffChangeNavigationState) => {
    onChangeNavigationUpdate?.(state);
  });

  const canEditEntry = Boolean(entry && editAdapter?.canEdit(entry));
  const isDirty = Boolean(entry && dirtyFileKey === entry.fileKey);
  const currentRequestKey = entry
    ? `${contentProvider.cacheScopeKey}::${entry.fileKey}::${retryCounter}`
    : null;
  const currentLoadedContent =
    currentRequestKey !== null && loadedRecord?.requestKey === currentRequestKey
      ? loadedRecord.content
      : null;
  const isLoading = Boolean(entry && currentLoadedContent === null);

  const revealChangeAt = (index: number) => {
    const editor = diffEditorRef.current;
    const list = changesRef.current;
    if (!editor || list.length === 0) return;
    const clamped = Math.max(0, Math.min(list.length - 1, index));
    const change = list[clamped];
    if (!change) return;

    activeChangeIndexRef.current = clamped;
    setActiveChangeIndex(clamped);
    notifyChangeNav({ currentIndex: clamped, totalCount: list.length });

    const modifiedEditor = editor.getModifiedEditor();
    const originalEditor = editor.getOriginalEditor();
    if (change.modifiedEndLineNumber > 0) {
      const line = Math.max(1, change.modifiedStartLineNumber);
      modifiedEditor.revealLineInCenter(line, monaco.editor.ScrollType.Smooth);
      modifiedEditor.setPosition({ lineNumber: line, column: 1 });
    } else {
      const line = Math.max(1, change.originalStartLineNumber);
      originalEditor.revealLineInCenter(line, monaco.editor.ScrollType.Smooth);
      const targetModLine = Math.max(1, change.modifiedStartLineNumber);
      modifiedEditor.revealLineInCenter(targetModLine, monaco.editor.ScrollType.Smooth);
    }
  };

  useImperativeHandle(ref, () => ({
    goToNextChange(): boolean {
      const list = changesRef.current;
      if (list.length === 0) return false;
      const nextIndex = activeChangeIndexRef.current + 1;
      if (nextIndex >= list.length) return false;
      revealChangeAt(nextIndex);
      return true;
    },
    goToPreviousChange(): boolean {
      const list = changesRef.current;
      if (list.length === 0) return false;
      const current = activeChangeIndexRef.current;
      const prevIndex = current <= 0 ? (current === -1 ? list.length - 1 : -1) : current - 1;
      if (prevIndex < 0) return false;
      revealChangeAt(prevIndex);
      return true;
    },
    goToChange(index: number): void {
      revealChangeAt(index);
    },
    focusFind(): void {
      const editor = diffEditorRef.current;
      if (!editor) return;
      const modifiedEditor = editor.getModifiedEditor();
      modifiedEditor.focus();
      void modifiedEditor.getAction("actions.find")?.run();
    },
    getCurrentLineNumber(): number | null {
      const editor = diffEditorRef.current;
      if (!editor) return null;
      return editor.getModifiedEditor().getPosition()?.lineNumber ?? null;
    },
  }));

  // Create and maintain a single Monaco Diff Editor instance; dynamic options are pushed in the next effect.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts and disposes the imperative Monaco Diff Editor instance
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureMonacoInitialized();

    const diffEditor = monaco.editor.createDiffEditor(container, {
      useInlineViewWhenSpaceIsLimited: false,
      renderIndicators: true,
      renderOverviewRuler: true,
      renderMarginRevertIcon: false,
      enableSplitViewResizing: true,
      diffAlgorithm: "advanced",
      originalEditable: false,
      readOnly: true,
      folding: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      stickyScroll: { enabled: true },
      fontFamily: readMonoFontFamily(),
      fontSize: 12.5,
      lineHeight: 19,
      padding: { top: 8, bottom: 12 },
    });

    diffEditorRef.current = diffEditor;
    setDiffEditorInstance(diffEditor);

    const diffDisposable = diffEditor.onDidUpdateDiff(() => {
      const nextChanges = toHunkChanges(diffEditor.getLineChanges());
      changesRef.current = nextChanges;
      setChanges(nextChanges);
      const nextIndex = nextChanges.length > 0 ? 0 : -1;
      activeChangeIndexRef.current = nextIndex;
      setActiveChangeIndex(nextIndex);
      notifyChangeNav({ currentIndex: nextIndex, totalCount: nextChanges.length });
    });

    return () => {
      diffDisposable.dispose();
      diffEditor.setModel(null);
      diffEditor.dispose();
      diffEditorRef.current = null;
      setDiffEditorInstance(null);
      if (modelsRef.current) {
        modelsRef.current.original.dispose();
        modelsRef.current.modified.dispose();
        modelsRef.current = null;
      }
    };
  }, [notifyChangeNav]);

  // Push reactive option & theme changes into the mounted Monaco instance.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates imperative Monaco options and theme when user settings change
  useEffect(() => {
    const diffEditor = diffEditorInstance;
    if (!diffEditor) return;
    syncMonacoTheme(resolvedTheme);
    diffEditor.updateOptions({
      renderSideBySide: viewMode === "split",
      ignoreTrimWhitespace: ignoreWhitespace,
      hideUnchangedRegions: {
        enabled: collapseUnchanged,
        contextLineCount: 3,
        minimumLineCount: 4,
      },
      wordWrap: wordWrap ? "on" : "off",
      readOnly: !canEditEntry,
      glyphMargin: Boolean(annotationAdapter),
    });
  }, [
    annotationAdapter,
    canEditEntry,
    collapseUnchanged,
    diffEditorInstance,
    ignoreWhitespace,
    resolvedTheme,
    viewMode,
    wordWrap,
  ]);

  // Load content for the currently selected file with LRU cache and cancellation.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches file contents asynchronously when active file or retry changes
  useEffect(() => {
    if (!entry || !currentRequestKey) return;

    if (contentCacheRef.current.scopeKey !== contentProvider.cacheScopeKey) {
      contentCacheRef.current = {
        scopeKey: contentProvider.cacheScopeKey,
        items: new Map(),
      };
    }

    const cacheKey = entry.fileKey;
    const cached = retryCounter === 0 ? contentCacheRef.current.items.get(cacheKey) : undefined;
    if (cached && cached.kind !== "error") {
      contentCacheRef.current.items.delete(cacheKey);
      contentCacheRef.current.items.set(cacheKey, cached);
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) {
          setLoadedRecord({ requestKey: currentRequestKey, content: cached });
        }
      });
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();

    void contentProvider
      .loadFileContent(entry, controller.signal)
      .then((content) => {
        if (controller.signal.aborted) return;
        if (content.kind !== "error") {
          contentCacheRef.current.items.set(cacheKey, content);
          if (contentCacheRef.current.items.size > MAX_CONTENT_CACHE_ENTRIES) {
            const oldestKey = contentCacheRef.current.items.keys().next().value;
            if (oldestKey) contentCacheRef.current.items.delete(oldestKey);
          }
        }
        setLoadedRecord({ requestKey: currentRequestKey, content });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadedRecord({
          requestKey: currentRequestKey,
          content: {
            kind: "error",
            message:
              error instanceof Error ? error.message : gt("Failed to load file diff contents."),
            retryable: true,
          },
        });
      });

    return () => {
      controller.abort();
    };
  }, [contentProvider, currentRequestKey, entry, gt, retryCounter]);

  const loadedText = currentLoadedContent?.kind === "text" ? currentLoadedContent : null;

  // Bind text models to Monaco and dispose previous models strictly to prevent leaks.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds new Monaco ITextModels for the loaded file and disposes old models
  useEffect(() => {
    const diffEditor = diffEditorInstance;
    if (!diffEditor) return;

    if (!entry || !loadedText) {
      diffEditor.setModel(null);
      if (modelsRef.current) {
        modelsRef.current.original.dispose();
        modelsRef.current.modified.dispose();
        modelsRef.current = null;
      }
      changesRef.current = [];
      activeChangeIndexRef.current = -1;
      notifyChangeNav({ currentIndex: -1, totalCount: 0 });
      return;
    }

    const originalModel = monaco.editor.createModel(loadedText.oldText, loadedText.language);
    const modifiedModel = monaco.editor.createModel(loadedText.newText, loadedText.language);

    const previousModels = modelsRef.current;
    modelsRef.current = { original: originalModel, modified: modifiedModel };
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    if (previousModels) {
      previousModels.original.dispose();
      previousModels.modified.dispose();
    }

    const changeDisposable = canEditEntry
      ? modifiedModel.onDidChangeContent(() => {
          const modified = modifiedModel.getValue() !== loadedText.newText;
          setDirtyFileKey(modified ? entry.fileKey : null);
        })
      : null;

    return () => {
      changeDisposable?.dispose();
    };
  }, [canEditEntry, diffEditorInstance, entry, loadedText, notifyChangeNav]);

  // P3 hook: save edited modified file via Cmd/Ctrl+S when editAdapter is provided.
  const handleSave = useStableCallback(async () => {
    if (!entry || !editAdapter || !canEditEntry || !modelsRef.current || isSaving) return;
    setIsSaving(true);
    try {
      const nextContent = modelsRef.current.modified.getValue();
      await editAdapter.saveFile(entry, nextContent);
      setDirtyFileKey(null);
    } finally {
      setIsSaving(false);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers Cmd/Ctrl+S save command on the Monaco modified editor when editable
  useEffect(() => {
    const diffEditor = diffEditorInstance;
    if (!diffEditor || !canEditEntry) return;
    const modifiedEditor = diffEditor.getModifiedEditor();
    const commandDisposable = modifiedEditor.addAction({
      id: "t3.ideDiff.save",
      label: gt("Save file"),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void handleSave();
      },
    });
    return () => commandDisposable.dispose();
  }, [canEditEntry, diffEditorInstance, gt, handleSave]);

  const showEditorSurface = Boolean(entry && loadedText);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Partial patch or P3 dirty-edit status bar */}
      {loadedText?.partial || (canEditEntry && isDirty) ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/35 px-3 py-1 text-2xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-1.5">
            <InfoIcon className="size-3.5 shrink-0 text-primary/80" />
            <span className="truncate">
              {loadedText?.partial ? (
                <T>
                  Showing patch hunk context only (full file contents are unavailable for this
                  snapshot).
                </T>
              ) : (
                <T>Unsaved edits in modified pane.</T>
              )}
            </span>
          </div>
          {canEditEntry && isDirty ? (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={isSaving}
              onClick={() => void handleSave()}
            >
              <SaveIcon className="size-3" />
              <span>{isSaving ? gt("Saving...") : gt("Save (⌘S)")}</span>
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Split column ref headers */}
      {showEditorSurface &&
      viewMode === "split" &&
      (loadedText?.oldLabel || loadedText?.newLabel) ? (
        <div className="grid shrink-0 grid-cols-2 border-b border-border/50 bg-muted/15 text-3xs font-medium text-muted-foreground">
          <div className="truncate border-r border-border/50 px-3 py-1">
            {loadedText.oldLabel ?? gt("Original")}
          </div>
          <div className="truncate px-3 py-1">{loadedText.newLabel ?? gt("Modified")}</div>
        </div>
      ) : null}

      {/* Editor mount point (kept mounted so Monaco instance is reused across files) */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          ref={containerRef}
          data-ide-monaco-container
          className={
            showEditorSurface ? "h-full w-full" : "invisible absolute inset-0 h-full w-full"
          }
        />

        {showEditorSurface && viewMode === "split" ? (
          <DiffConnectorOverlay
            diffEditor={diffEditorInstance}
            changes={changes}
            activeChangeIndex={activeChangeIndex}
            resolvedTheme={resolvedTheme}
            onSelectChange={revealChangeAt}
          />
        ) : null}

        {showEditorSurface && loadedText ? (
          <MonacoAnnotationLayer
            diffEditor={diffEditorInstance}
            entry={entry}
            oldText={loadedText.oldText}
            newText={loadedText.newText}
            viewMode={viewMode}
            annotationAdapter={annotationAdapter}
          />
        ) : null}

        {/* Loading overlay */}
        {isLoading && entry ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background/85 text-xs text-muted-foreground">
            <RefreshCwIcon className="size-4 animate-spin opacity-70" />
            <span>{gt("Loading {path}...", { path: entry.path })}</span>
          </div>
        ) : null}

        {/* Binary / Image / Too-large / Error fallback states */}
        {entry && currentLoadedContent && currentLoadedContent.kind !== "text" ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            {currentLoadedContent.kind === "binary" && currentLoadedContent.isImage ? (
              <ImageIcon className="size-8 text-muted-foreground/60" />
            ) : currentLoadedContent.kind === "too-large" ? (
              <FileWarningIcon className="size-8 text-warning" />
            ) : (
              <AlertTriangleIcon className="size-8 text-muted-foreground/70" />
            )}

            <div className="max-w-md space-y-1">
              <p className="font-mono text-xs font-medium text-foreground">{entry.path}</p>
              <p className="text-xs text-muted-foreground">
                {currentLoadedContent.kind === "error"
                  ? currentLoadedContent.message
                  : currentLoadedContent.reason}
              </p>
            </div>

            <div className="flex items-center gap-2">
              {currentLoadedContent.kind === "error" && currentLoadedContent.retryable ? (
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => setRetryCounter((count) => count + 1)}
                >
                  <RefreshCwIcon className="size-3.5" />
                  <span>
                    <T>Retry</T>
                  </span>
                </Button>
              ) : null}
              {onOpenExternal ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => onOpenExternal({ entry })}
                >
                  <ExternalLinkIcon className="size-3.5" />
                  <span>
                    <T>Open in external editor</T>
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
