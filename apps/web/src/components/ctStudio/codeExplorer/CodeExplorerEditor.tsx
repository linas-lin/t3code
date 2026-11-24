import { T, useGT } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CompassIcon,
  CopyIcon,
  ExternalLinkIcon,
  Link2Icon,
  Loader2Icon,
  SendHorizontalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { syncMonacoTheme } from "../ideDiff/monacoTheme";
import { ensureMonacoInitialized, monaco } from "../ideDiff/monacoWorkers";
import { checkTextContentSafety, inferMonacoLanguage } from "../ideDiff/patchFallback.logic";
import { buildExplorerFileKey } from "./codeExplorerStore";
import { extractSymbolAtPosition } from "./symbolNavigation.logic";
import type { ExplorerFileTarget } from "./types";

const MAX_FILE_CACHE = 24;
const FALLBACK_MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const HIGHLIGHT_STYLE_ID = "t3-code-explorer-highlight-style";

function ensureHighlightStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
.t3-code-explorer-reveal-line {
  background-color: color-mix(in srgb, var(--primary, #2563eb) 18%, transparent) !important;
}
.t3-code-explorer-cmd-hover {
  text-decoration: underline;
  cursor: pointer !important;
}
`;
  document.head.appendChild(style);
}

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

export interface CodeExplorerEditorProps {
  readonly activeTarget: ExplorerFileTarget | null;
  readonly focusEditorToken?: number | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onNavigateBack: () => void;
  readonly onNavigateForward: () => void;
  readonly onGoToDefinition: (input: {
    readonly symbol: string;
    readonly qualifier?: string | undefined;
    readonly target: ExplorerFileTarget;
    readonly fileText: string;
    readonly language: string;
  }) => void;
  readonly onFindUsages: (input: {
    readonly symbol: string;
    readonly target: ExplorerFileTarget;
  }) => void;
  readonly onSendToChat?:
    | ((input: {
        readonly target: ExplorerFileTarget;
        readonly startLine: number;
        readonly endLine: number;
        readonly contents: string;
      }) => void)
    | undefined;
  readonly onOpenExternal?: ((target: ExplorerFileTarget, lineNumber?: number) => void) | undefined;
}

type LoadedFileState =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly language: string;
      readonly truncated: boolean;
    }
  | { readonly kind: "error"; readonly message: string };

export function CodeExplorerEditor({
  activeTarget,
  focusEditorToken = 0,
  resolvedTheme,
  canGoBack,
  canGoForward,
  onNavigateBack,
  onNavigateForward,
  onGoToDefinition,
  onFindUsages,
  onSendToChat,
  onOpenExternal,
}: CodeExplorerEditorProps) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(
    null,
  );
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const cacheRef = useRef<Map<string, LoadedFileState>>(new Map());
  const revealDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const [loadedRecord, setLoadedRecord] = useState<{
    readonly fileKey: string;
    readonly state: LoadedFileState;
  } | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [selectionRange, setSelectionRange] = useState<{
    readonly startLine: number;
    readonly endLine: number;
  } | null>(null);

  const runReadFile = useAtomQueryRunner(projectEnvironment.readFile, {
    label: "code-explorer:read-file",
    reportFailure: false,
  });

  const activeFileKey = activeTarget
    ? buildExplorerFileKey(activeTarget.repoId, activeTarget.relativePath)
    : null;
  const activeLoaded =
    activeFileKey && loadedRecord?.fileKey === activeFileKey ? loadedRecord.state : null;
  const activeText = activeLoaded?.kind === "text" ? activeLoaded : null;
  const isLoading = Boolean(activeFileKey && activeLoaded === null);

  const triggerDefinitionAtPosition = useStableCallback(
    (position: { readonly lineNumber: number; readonly column: number } | null) => {
      const editor = editorRef.current;
      const model = modelRef.current;
      if (!editor || !model || !activeTarget || !activeText) return;
      const pos = position ?? editor.getPosition();
      if (!pos) return;
      const lineText = model.getLineContent(pos.lineNumber);
      const extracted = extractSymbolAtPosition(lineText, pos.column);
      if (!extracted) return;
      onGoToDefinition({
        symbol: extracted.symbol,
        qualifier: extracted.qualifier,
        target: { ...activeTarget, lineNumber: pos.lineNumber, column: pos.column },
        fileText: activeText.text,
        language: activeText.language,
      });
    },
  );

  const triggerUsagesAtPosition = useStableCallback(
    (position: { readonly lineNumber: number; readonly column: number } | null) => {
      const editor = editorRef.current;
      const model = modelRef.current;
      if (!editor || !model || !activeTarget) return;
      const pos = position ?? editor.getPosition();
      if (!pos) return;
      const lineText = model.getLineContent(pos.lineNumber);
      const extracted = extractSymbolAtPosition(lineText, pos.column);
      if (!extracted) return;
      onFindUsages({
        symbol: extracted.symbol,
        target: { ...activeTarget, lineNumber: pos.lineNumber, column: pos.column },
      });
    },
  );

  const triggerSendSelection = useStableCallback(() => {
    const editor = editorRef.current;
    if (!editor || !activeTarget || !activeText || !onSendToChat) return;
    const sel = editor.getSelection();
    const pos = editor.getPosition();
    const startLine =
      sel && !sel.isEmpty()
        ? Math.min(sel.startLineNumber, sel.endLineNumber)
        : (pos?.lineNumber ?? 1);
    const endLine =
      sel && !sel.isEmpty() ? Math.max(sel.startLineNumber, sel.endLineNumber) : startLine;
    onSendToChat({
      target: activeTarget,
      startLine,
      endLine,
      contents: activeText.text,
    });
  });

  // Mount single Monaco Code Editor instance with IDEA-compatible bindings.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts and disposes imperative Monaco Code Editor instance
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    ensureMonacoInitialized();
    ensureHighlightStyles();

    const editor = monaco.editor.create(container, {
      readOnly: true,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      stickyScroll: { enabled: true },
      renderLineHighlight: "all",
      fontFamily: readMonoFontFamily(),
      fontSize: 12.5,
      lineHeight: 19,
      padding: { top: 8, bottom: 16 },
      folding: true,
    });

    editorRef.current = editor;
    revealDecorationsRef.current = editor.createDecorationsCollection();
    const cmdHoverDecorations = editor.createDecorationsCollection();
    setEditorInstance(editor);

    // IntelliJ IDEA shortcuts inside the editor:
    // - Cmd+B / Ctrl+B and F12: Go to Declaration / Definition
    // - Option+F7 / Alt+F7 and Shift+F12: Find Usages
    const disposables: monaco.IDisposable[] = [
      editor.addAction({
        id: "t3.codeExplorer.goToDefinition",
        label: gt("Go to Definition"),
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, monaco.KeyCode.F12],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 1,
        run: () => triggerDefinitionAtPosition(null),
      }),
      editor.addAction({
        id: "t3.codeExplorer.findUsages",
        label: gt("Find Usages"),
        keybindings: [
          monaco.KeyMod.Alt | monaco.KeyCode.F7,
          monaco.KeyMod.Shift | monaco.KeyCode.F12,
        ],
        contextMenuGroupId: "navigation",
        contextMenuOrder: 2,
        run: () => triggerUsagesAtPosition(null),
      }),
      editor.addAction({
        id: "t3.codeExplorer.sendSelectionToChat",
        label: gt("Send Selection to Chat"),
        contextMenuGroupId: "9_cutcopypaste",
        contextMenuOrder: 5,
        run: () => triggerSendSelection(),
      }),
      editor.onDidChangeCursorSelection((event) => {
        const sel = event.selection;
        if (sel.isEmpty()) {
          setSelectionRange(null);
        } else {
          setSelectionRange({
            startLine: Math.min(sel.startLineNumber, sel.endLineNumber),
            endLine: Math.max(sel.startLineNumber, sel.endLineNumber),
          });
        }
      }),
      editor.onMouseMove((event) => {
        const metaOrCtrl = event.event.metaKey || event.event.ctrlKey;
        const pos = event.target.position;
        const model = editor.getModel();
        if (!metaOrCtrl || !pos || !model) {
          cmdHoverDecorations.clear();
          return;
        }
        const word = model.getWordAtPosition(pos);
        if (!word) {
          cmdHoverDecorations.clear();
          return;
        }
        cmdHoverDecorations.set([
          {
            range: new monaco.Range(
              pos.lineNumber,
              word.startColumn,
              pos.lineNumber,
              word.endColumn,
            ),
            options: { inlineClassName: "t3-code-explorer-cmd-hover" },
          },
        ]);
      }),
      editor.onMouseLeave(() => {
        cmdHoverDecorations.clear();
      }),
      editor.onMouseDown((event) => {
        const metaOrCtrl = event.event.metaKey || event.event.ctrlKey;
        if (metaOrCtrl && event.target.position) {
          cmdHoverDecorations.clear();
          triggerDefinitionAtPosition(event.target.position);
        }
      }),
    ];

    return () => {
      cmdHoverDecorations.clear();
      revealDecorationsRef.current?.clear();
      revealDecorationsRef.current = null;
      for (const d of disposables) d.dispose();
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
      setEditorInstance(null);
      if (modelRef.current) {
        modelRef.current.dispose();
        modelRef.current = null;
      }
    };
  }, [gt, triggerDefinitionAtPosition, triggerSendSelection, triggerUsagesAtPosition]);

  // Keep Monaco theme synchronized.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes theme changes into mounted Monaco editor
  useEffect(() => {
    if (!editorInstance) return;
    syncMonacoTheme(resolvedTheme);
  }, [editorInstance, resolvedTheme]);

  // Move focus into Monaco when user confirms a candidate with Enter in the sidebar.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses imperative Monaco editor on explicit Enter action
  useEffect(() => {
    if (!editorInstance || focusEditorToken <= 0) return;
    const frame = window.requestAnimationFrame(() => {
      editorInstance.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorInstance, focusEditorToken]);

  // Fetch file contents on file switch with LRU caching.
  const activeEnvironmentId = activeTarget?.environmentId ?? null;
  const activeCwd = activeTarget?.cwd ?? null;
  const activeRelativePath = activeTarget?.relativePath ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads active file text asynchronously with LRU cache
  useEffect(() => {
    if (!activeFileKey || !activeEnvironmentId || !activeCwd || !activeRelativePath) return;

    const cached = cacheRef.current.get(activeFileKey);
    if (cached) {
      cacheRef.current.delete(activeFileKey);
      cacheRef.current.set(activeFileKey, cached);
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) setLoadedRecord({ fileKey: activeFileKey, state: cached });
      });
      return () => {
        cancelled = true;
      };
    }

    const controller = new AbortController();
    void runReadFile(
      {
        environmentId: activeEnvironmentId,
        input: {
          cwd: activeCwd,
          relativePath: activeRelativePath,
        },
      },
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        let nextState: LoadedFileState;
        if (result._tag === "Success") {
          const safety = checkTextContentSafety(result.value.contents, "");
          if (!safety.ok) {
            nextState = {
              kind: "error",
              message:
                safety.reason === "binary"
                  ? gt("Binary file cannot be displayed in the code viewer.")
                  : gt("File exceeds inline code viewer safety limit."),
            };
          } else {
            nextState = {
              kind: "text",
              text: result.value.contents,
              language: inferMonacoLanguage(activeRelativePath),
              truncated: result.value.truncated,
            };
          }
        } else {
          nextState = {
            kind: "error",
            message: gt("Unable to read {path}.", { path: activeRelativePath }),
          };
        }

        if (nextState.kind === "text") {
          cacheRef.current.set(activeFileKey, nextState);
          if (cacheRef.current.size > MAX_FILE_CACHE) {
            const oldestKey = cacheRef.current.keys().next().value;
            if (oldestKey) cacheRef.current.delete(oldestKey);
          }
        }
        setLoadedRecord({ fileKey: activeFileKey, state: nextState });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadedRecord({
          fileKey: activeFileKey,
          state: {
            kind: "error",
            message: error instanceof Error ? error.message : gt("Failed to read file."),
          },
        });
      });

    return () => {
      controller.abort();
    };
  }, [activeCwd, activeEnvironmentId, activeFileKey, activeRelativePath, gt, runReadFile]);

  // Bind Monaco model and dispose previous model cleanly.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- updates Monaco ITextModel when active file changes
  useEffect(() => {
    const editor = editorInstance;
    if (!editor) return;

    if (!activeFileKey || !activeText) {
      editor.setModel(null);
      if (modelRef.current) {
        modelRef.current.dispose();
        modelRef.current = null;
      }
      return;
    }

    const nextModel = monaco.editor.createModel(activeText.text, activeText.language);
    const previous = modelRef.current;
    modelRef.current = nextModel;
    editor.setModel(nextModel);
    if (previous) previous.dispose();
  }, [activeFileKey, activeText, editorInstance]);

  // Reveal and highlight target line whenever file or revealToken changes.
  const targetLine = activeTarget?.lineNumber;
  const targetCol = activeTarget?.column ?? 1;
  const revealToken = activeTarget?.revealToken ?? 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls Monaco to the requested symbol/match line and highlights it
  useEffect(() => {
    const editor = editorInstance;
    const model = modelRef.current;
    if (!editor || !model || !activeText || !targetLine || revealToken < 0) return;

    const clampedLine = Math.max(1, Math.min(model.getLineCount(), targetLine));
    const clampedCol = Math.max(1, targetCol);
    editor.revealLineInCenter(clampedLine, monaco.editor.ScrollType.Smooth);
    editor.setPosition({ lineNumber: clampedLine, column: clampedCol });
    revealDecorationsRef.current?.set([
      {
        range: new monaco.Range(clampedLine, 1, clampedLine, 1),
        options: {
          isWholeLine: true,
          className: "t3-code-explorer-reveal-line",
        },
      },
    ]);
  }, [activeText, editorInstance, revealToken, targetCol, targetLine]);

  const copyPath = () => {
    if (!activeTarget || typeof navigator === "undefined" || !navigator.clipboard) return;
    const line = editorRef.current?.getPosition()?.lineNumber;
    const value = line ? `${activeTarget.relativePath}:${line}` : activeTarget.relativePath;
    void navigator.clipboard.writeText(value).then(() => {
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1200);
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Breadcrumb + navigation + actions toolbar */}
      {activeTarget ? (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-2">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!canGoBack}
                    aria-label={gt("Navigate back")}
                    onClick={onNavigateBack}
                  />
                }
              >
                <ArrowLeftIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{gt("Navigate back (⌘[ / ⌘⌥←)")}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!canGoForward}
                    aria-label={gt("Navigate forward")}
                    onClick={onNavigateForward}
                  />
                }
              >
                <ArrowRightIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{gt("Navigate forward (⌘] / ⌘⌥→)")}</TooltipPopup>
            </Tooltip>

            <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 font-mono text-3xs font-medium text-primary">
              {activeTarget.repoName}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={<span className="min-w-0 truncate font-mono text-xs text-foreground/90" />}
              >
                {activeTarget.relativePath}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {`${activeTarget.cwd}/${activeTarget.relativePath}`}
              </TooltipPopup>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("Copy path with line number")}
                    onClick={copyPath}
                  />
                }
              >
                {copiedPath ? (
                  <CheckIcon className="size-3 text-success" />
                ) : (
                  <CopyIcon className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {copiedPath ? gt("Copied") : gt("Copy path:line")}
              </TooltipPopup>
            </Tooltip>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={!activeText}
                    onClick={() => triggerDefinitionAtPosition(null)}
                  />
                }
              >
                <CompassIcon className="size-3.5" />
                <span className="hidden lg:inline">
                  <T>Definition</T>
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {gt("Go to Declaration / Definition (⌘B / F12 / ⌘+Click)")}
              </TooltipPopup>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost-muted"
                    disabled={!activeText}
                    onClick={() => triggerUsagesAtPosition(null)}
                  />
                }
              >
                <Link2Icon className="size-3.5" />
                <span className="hidden lg:inline">
                  <T>Usages</T>
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                {gt("Find Usages across selected repos (⌥F7 / ⇧F12)")}
              </TooltipPopup>
            </Tooltip>

            {onSendToChat && activeText ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="xs"
                      variant={selectionRange ? "secondary" : "ghost-muted"}
                      onClick={triggerSendSelection}
                    />
                  }
                >
                  <SendHorizontalIcon className="size-3.5" />
                  <span>
                    {selectionRange
                      ? gt("Send L{start}-{end}", {
                          start: selectionRange.startLine,
                          end: selectionRange.endLine,
                        })
                      : gt("Send to chat")}
                  </span>
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  {gt("Attach selected lines (or current line) to the active chat composer")}
                </TooltipPopup>
              </Tooltip>
            ) : null}

            {onOpenExternal ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("Open in external editor")}
                      onClick={() =>
                        onOpenExternal(
                          activeTarget,
                          editorRef.current?.getPosition()?.lineNumber ?? activeTarget.lineNumber,
                        )
                      }
                    />
                  }
                >
                  <ExternalLinkIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  {gt("Open in external editor (IDEA / VS Code)")}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Editor surface */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className={activeText ? "h-full w-full" : "invisible absolute inset-0 h-full w-full"}
        />

        {!activeTarget ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
            <p className="font-medium text-foreground/80">
              <T>Select a search match or file on the left to inspect code.</T>
            </p>
            <p className="text-3xs text-muted-foreground/80">
              <T>
                IDEA Shortcuts: ⌘⇧F (Find in Files) · ⌘⇧O (Go to File) · Double Shift (Search
                Everywhere) · ⌘B / ⌘+Click (Definition) · ⌥F7 (Find Usages) · ⌘[ / ⌘] (Back/Forward)
              </T>
            </p>
          </div>
        ) : isLoading ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center gap-2 bg-background/85 text-xs text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{gt("Loading {path}...", { path: activeTarget.relativePath })}</span>
          </div>
        ) : activeLoaded?.kind === "error" ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <AlertTriangleIcon className="size-7 text-warning" />
            <p className="font-mono text-xs text-foreground">{activeTarget.relativePath}</p>
            <p className="text-xs text-muted-foreground">{activeLoaded.message}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
