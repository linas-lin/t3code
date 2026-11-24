import { useGT } from "gt-react";
import { MessageSquarePlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { DiffCommentAnnotation } from "../../diffs/DiffCommentAnnotation";
import { Button } from "../../ui/button";
import { monaco } from "./monacoWorkers";
import type {
  IdeDiffAnnotationAdapter,
  IdeDiffAnnotationSide,
  IdeDiffFileEntry,
  IdeDiffInlineAnnotation,
} from "./types";

export interface MonacoAnnotationLayerProps {
  readonly diffEditor: monaco.editor.IStandaloneDiffEditor | null;
  readonly entry: IdeDiffFileEntry | null;
  readonly oldText: string;
  readonly newText: string;
  readonly viewMode: "split" | "unified";
  readonly annotationAdapter?: IdeDiffAnnotationAdapter | undefined;
}

interface DraftTarget {
  readonly fileKey: string;
  readonly side: IdeDiffAnnotationSide;
  readonly startLine: number;
  readonly endLine: number;
}

interface SelectionPrompt {
  readonly fileKey: string;
  readonly side: IdeDiffAnnotationSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly topPx: number;
  readonly rightPx: number;
}

interface ZoneGroup {
  readonly key: string;
  readonly side: IdeDiffAnnotationSide;
  readonly afterLineNumber: number;
  readonly annotations: ReadonlyArray<IdeDiffInlineAnnotation>;
  readonly draft?: DraftTarget | undefined;
}

interface OverlayBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly visible: boolean;
}

function formatLineRangeLabel(
  side: IdeDiffAnnotationSide,
  startLine: number,
  endLine: number,
): string {
  const prefix = side === "original" ? "-" : "+";
  const minLine = Math.min(startLine, endLine);
  const maxLine = Math.max(startLine, endLine);
  return minLine === maxLine ? `${prefix}${minLine}` : `${prefix}${minLine} to ${prefix}${maxLine}`;
}

const GUTTER_STYLE_ID = "t3-ide-diff-gutter-annotation-style";

function ensureGutterStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(GUTTER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = GUTTER_STYLE_ID;
  style.textContent = `
.t3-ide-diff-add-comment-glyph {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.t3-ide-diff-add-comment-glyph::before {
  content: "+";
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  background: var(--primary, #2563eb);
  color: var(--primary-foreground, #ffffff);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
}
`;
  document.head.appendChild(style);
}

function computeEditorHorizontalBounds(
  diffEditor: monaco.editor.IStandaloneDiffEditor,
  side: IdeDiffAnnotationSide,
  viewMode: "split" | "unified",
): { readonly left: number; readonly width: number } {
  const originalEditor = diffEditor.getOriginalEditor();
  const modifiedEditor = diffEditor.getModifiedEditor();
  const origLayout = originalEditor.getLayoutInfo();
  const modLayout = modifiedEditor.getLayoutInfo();

  if (viewMode === "unified") {
    return {
      left: modLayout.contentLeft + 4,
      width: Math.max(220, modLayout.contentWidth - 20),
    };
  }

  if (side === "original") {
    return {
      left: origLayout.contentLeft + 4,
      width: Math.max(220, origLayout.contentWidth - 20),
    };
  }

  const origDom = originalEditor.getDomNode();
  const modDom = modifiedEditor.getDomNode();
  const rootDom = diffEditor.getContainerDomNode();
  let paneOffsetLeft = origLayout.width;
  if (modDom && rootDom) {
    const rootRect = rootDom.getBoundingClientRect();
    const modRect = modDom.getBoundingClientRect();
    if (modRect.width > 0 && rootRect.width > 0) {
      paneOffsetLeft = modRect.left - rootRect.left;
    }
  } else if (origDom) {
    paneOffsetLeft = origDom.getBoundingClientRect().width;
  }

  return {
    left: paneOffsetLeft + modLayout.contentLeft + 4,
    width: Math.max(220, modLayout.contentWidth - 20),
  };
}

export function MonacoAnnotationLayer({
  diffEditor,
  entry,
  oldText,
  newText,
  viewMode,
  annotationAdapter,
}: MonacoAnnotationLayerProps) {
  const gt = useGT();
  const [draftState, setDraft] = useState<DraftTarget | null>(null);
  const [draftText, setDraftText] = useState("");
  const [selectionPromptState, setSelectionPrompt] = useState<SelectionPrompt | null>(null);
  const [overlayBoxes, setOverlayBoxes] = useState<Readonly<Record<string, OverlayBox>>>({});
  const overlayNodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const zoneRecordsRef = useRef<
    Map<
      string,
      {
        editor: monaco.editor.IStandaloneCodeEditor;
        zoneId: string;
        spec: monaco.editor.IViewZone;
      }
    >
  >(new Map());

  const entryKey = entry?.fileKey ?? null;
  const draft = draftState && draftState.fileKey === entryKey ? draftState : null;
  const selectionPrompt =
    selectionPromptState && selectionPromptState.fileKey === entryKey ? selectionPromptState : null;

  const annotations = entry && annotationAdapter ? annotationAdapter.getAnnotations(entry) : [];

  // Build grouped inline annotation slots.
  const groups: ZoneGroup[] = (() => {
    if (!entry || !annotationAdapter) return [];
    const map = new Map<
      string,
      {
        side: IdeDiffAnnotationSide;
        afterLineNumber: number;
        annotations: IdeDiffInlineAnnotation[];
        draft?: DraftTarget;
      }
    >();

    for (const item of annotations) {
      const effectiveSide: IdeDiffAnnotationSide = viewMode === "unified" ? "modified" : item.side;
      const key = `${effectiveSide}:${item.endLine}`;
      const existing = map.get(key);
      if (existing) {
        existing.annotations.push(item);
      } else {
        map.set(key, {
          side: effectiveSide,
          afterLineNumber: item.endLine,
          annotations: [item],
        });
      }
    }

    if (draft) {
      const effectiveSide: IdeDiffAnnotationSide = viewMode === "unified" ? "modified" : draft.side;
      const key = `${effectiveSide}:${draft.endLine}`;
      const existing = map.get(key);
      if (existing) {
        existing.draft = draft;
      } else {
        map.set(key, {
          side: effectiveSide,
          afterLineNumber: draft.endLine,
          annotations: [],
          draft,
        });
      }
    }

    return Array.from(map.entries()).map(([key, value]) => ({
      key,
      side: value.side,
      afterLineNumber: value.afterLineNumber,
      annotations: value.annotations,
      draft: value.draft,
    }));
  })();

  // Bind gutter hover '+' and multi-line selection prompt on editors.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers imperative Monaco mouse/selection listeners for inline commenting
  useEffect(() => {
    if (!diffEditor || !entry || !annotationAdapter) return;
    ensureGutterStyles();

    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    const pairs: ReadonlyArray<
      readonly [IdeDiffAnnotationSide, monaco.editor.IStandaloneCodeEditor]
    > =
      viewMode === "unified"
        ? [["modified", modifiedEditor]]
        : [
            ["original", originalEditor],
            ["modified", modifiedEditor],
          ];

    const disposables: monaco.IDisposable[] = [];

    for (const [side, editor] of pairs) {
      const hoverDecorations = editor.createDecorationsCollection();
      let hoveredLine: number | null = null;

      disposables.push(
        editor.onMouseMove((event) => {
          const targetType = event.target.type;
          const lineNumber = event.target.position?.lineNumber ?? null;
          const overGutter =
            lineNumber !== null &&
            (targetType === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
              targetType === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS ||
              targetType === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS);

          if (!overGutter || lineNumber === null) {
            if (hoveredLine !== null) {
              hoveredLine = null;
              hoverDecorations.clear();
            }
            return;
          }

          if (hoveredLine === lineNumber) return;
          hoveredLine = lineNumber;
          hoverDecorations.set([
            {
              range: new monaco.Range(lineNumber, 1, lineNumber, 1),
              options: {
                isWholeLine: false,
                glyphMarginClassName: "t3-ide-diff-add-comment-glyph",
                glyphMarginHoverMessage: {
                  value: gt("Add review comment on line {line}", { line: lineNumber }),
                },
              },
            },
          ]);
        }),
      );

      disposables.push(
        editor.onMouseLeave(() => {
          if (hoveredLine !== null) {
            hoveredLine = null;
            hoverDecorations.clear();
          }
        }),
      );

      disposables.push(
        editor.onMouseDown((event) => {
          if (
            event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
            event.target.position?.lineNumber
          ) {
            const lineNumber = event.target.position.lineNumber;
            const currentSelection = editor.getSelection();
            const spansLine =
              currentSelection &&
              !currentSelection.isEmpty() &&
              lineNumber >= currentSelection.startLineNumber &&
              lineNumber <= currentSelection.endLineNumber;
            setSelectionPrompt(null);
            setDraftText("");
            setDraft({
              fileKey: entry.fileKey,
              side,
              startLine: spansLine ? currentSelection.startLineNumber : lineNumber,
              endLine: spansLine ? currentSelection.endLineNumber : lineNumber,
            });
          }
        }),
      );

      disposables.push(
        editor.onDidChangeCursorSelection((event) => {
          const sel = event.selection;
          if (sel.isEmpty()) {
            setSelectionPrompt((current) => (current?.side === side ? null : current));
            return;
          }
          const startLine = Math.min(sel.startLineNumber, sel.endLineNumber);
          const endLine = Math.max(sel.startLineNumber, sel.endLineNumber);
          const top = editor.getTopForLineNumber(endLine) - editor.getScrollTop();
          const layout = editor.getLayoutInfo();
          if (top < 0 || top > layout.height) {
            setSelectionPrompt(null);
            return;
          }
          const origLayout = originalEditor.getLayoutInfo();
          const rightPx =
            viewMode === "split" && side === "original"
              ? Math.max(12, modifiedEditor.getLayoutInfo().width + 24)
              : 24;
          setSelectionPrompt({
            fileKey: entry.fileKey,
            side,
            startLine,
            endLine,
            topPx: Math.max(6, Math.min(layout.height - 34, top)),
            rightPx: origLayout.width > 0 ? rightPx : 24,
          });
        }),
      );

      disposables.push({
        dispose: () => {
          hoverDecorations.clear();
        },
      });
    }

    return () => {
      for (const disposable of disposables) disposable.dispose();
    };
  }, [annotationAdapter, diffEditor, entry, gt, viewMode]);

  // Manage empty Monaco ViewZones as height spacers + track exact top/left/width for interactive top-layer overlays.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- synchronizes imperative Monaco ViewZone spacers and their overlay coordinates
  useEffect(() => {
    if (!diffEditor || !entry || !annotationAdapter) return;

    const originalEditor = diffEditor.getOriginalEditor();
    const modifiedEditor = diffEditor.getModifiedEditor();
    const created: Array<{
      key: string;
      side: IdeDiffAnnotationSide;
      editor: monaco.editor.IStandaloneCodeEditor;
      zoneId: string;
      spec: monaco.editor.IViewZone;
    }> = [];
    const nextRecords = new Map<
      string,
      {
        editor: monaco.editor.IStandaloneCodeEditor;
        zoneId: string;
        spec: monaco.editor.IViewZone;
      }
    >();
    const zoneTopByKey = new Map<string, number>();
    let frameId = 0;

    const flushOverlayBoxes = () => {
      const next: Record<string, OverlayBox> = {};
      for (const item of created) {
        const top = zoneTopByKey.get(item.key);
        const editorHeight = item.editor.getLayoutInfo().height;
        const height = item.spec.heightInPx ?? 80;
        const bounds = computeEditorHorizontalBounds(diffEditor, item.side, viewMode);
        const visible = top !== undefined && top + height > -16 && top < editorHeight + 16;
        next[item.key] = {
          top: top ?? 0,
          left: bounds.left,
          width: bounds.width,
          visible,
        };
      }
      setOverlayBoxes(next);
    };

    const scheduleFlush = () => {
      if (frameId !== 0) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        flushOverlayBoxes();
      });
    };

    const addSideSpacers = (
      side: IdeDiffAnnotationSide,
      editor: monaco.editor.IStandaloneCodeEditor,
    ) => {
      const sideGroups = groups.filter((group) => group.side === side);
      if (sideGroups.length === 0) return;

      editor.changeViewZones((accessor) => {
        for (const group of sideGroups) {
          // Empty spacer node inside Monaco; interactive UI lives in the top-layer overlay so clicks are never intercepted.
          const spacerNode = document.createElement("div");
          spacerNode.style.pointerEvents = "none";

          // Empty margin node prevents Monaco from rendering stray negative/wrapped line numbers beside the ViewZone.
          const marginNode = document.createElement("div");
          marginNode.style.pointerEvents = "none";

          const measuredNode = overlayNodesRef.current.get(group.key);
          const initialHeight = measuredNode
            ? Math.max(48, Math.ceil(measuredNode.getBoundingClientRect().height) + 12)
            : group.annotations.length * 56 + (group.draft ? 142 : 0) + 16;

          const spec: monaco.editor.IViewZone = {
            afterLineNumber: group.afterLineNumber,
            heightInPx: initialHeight,
            domNode: spacerNode,
            marginDomNode: marginNode,
            suppressMouseDown: false,
            onDomNodeTop: (top) => {
              zoneTopByKey.set(group.key, top);
              scheduleFlush();
            },
          };

          const zoneId = accessor.addZone(spec);
          created.push({ key: group.key, side, editor, zoneId, spec });
          nextRecords.set(group.key, { editor, zoneId, spec });
        }
      });
    };

    addSideSpacers("original", originalEditor);
    addSideSpacers("modified", modifiedEditor);
    zoneRecordsRef.current = nextRecords;
    scheduleFlush();

    const disposables = [
      originalEditor.onDidLayoutChange(scheduleFlush),
      modifiedEditor.onDidLayoutChange(scheduleFlush),
      originalEditor.onDidScrollChange(scheduleFlush),
      modifiedEditor.onDidScrollChange(scheduleFlush),
    ];

    return () => {
      if (frameId !== 0) window.cancelAnimationFrame(frameId);
      for (const disposable of disposables) disposable.dispose();
      const byEditor = new Map<monaco.editor.IStandaloneCodeEditor, string[]>();
      for (const item of created) {
        const list = byEditor.get(item.editor) ?? [];
        list.push(item.zoneId);
        byEditor.set(item.editor, list);
      }
      for (const [editor, ids] of byEditor) {
        try {
          editor.changeViewZones((accessor) => {
            for (const id of ids) accessor.removeZone(id);
          });
        } catch {
          // Editor may already be disposed on unmount.
        }
      }
      zoneRecordsRef.current = new Map();
    };
  }, [annotationAdapter, diffEditor, entry, groups, viewMode]);

  // Keep Monaco ViewZone spacer heights synced to the rendered overlay card heights.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes rendered overlay heights and updates Monaco ViewZone heights
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    for (const group of groups) {
      const node = overlayNodesRef.current.get(group.key);
      if (!node) continue;
      const syncHeight = () => {
        const record = zoneRecordsRef.current.get(group.key);
        if (!record) return;
        const measured = Math.max(48, Math.ceil(node.getBoundingClientRect().height) + 12);
        if (Math.abs((record.spec.heightInPx ?? 0) - measured) > 2) {
          record.spec.heightInPx = measured;
          try {
            record.editor.changeViewZones((accessor) => {
              accessor.layoutZone(record.zoneId);
            });
          } catch {
            // Editor may be disposed.
          }
        }
      };
      syncHeight();
      cleanups.push(observeResize(node, syncHeight));
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [groups]);

  // Allow pressing Escape anywhere while a draft box is open to dismiss it cleanly.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds Escape key to close the active draft comment overlay
  useEffect(() => {
    if (!draft) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraft(null);
        setDraftText("");
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [draft]);

  if (!diffEditor || !entry || !annotationAdapter) return null;

  const closeDraft = () => {
    setDraft(null);
    setDraftText("");
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden">
      {selectionPrompt && !draft ? (
        <button
          type="button"
          onClick={() => {
            setDraftText("");
            setDraft({
              fileKey: entry.fileKey,
              side: selectionPrompt.side,
              startLine: selectionPrompt.startLine,
              endLine: selectionPrompt.endLine,
            });
            setSelectionPrompt(null);
          }}
          style={{ top: `${selectionPrompt.topPx}px`, right: `${selectionPrompt.rightPx}px` }}
          className="pointer-events-auto absolute z-40 inline-flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-2xs font-medium text-popover-foreground shadow-md transition-colors hover:bg-accent"
        >
          <MessageSquarePlusIcon className="size-3" />
          <span>{gt("Comment")}</span>
        </button>
      ) : null}

      {groups.map((group) => {
        const box = overlayBoxes[group.key];
        if (!box || !box.visible) return null;
        return (
          <div
            key={group.key}
            ref={(el) => {
              if (el) overlayNodesRef.current.set(group.key, el);
              else overlayNodesRef.current.delete(group.key);
            }}
            style={{
              top: `${box.top + 6}px`,
              left: `${box.left}px`,
              width: `${box.width}px`,
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className="pointer-events-auto absolute z-30 overflow-hidden rounded-md border border-border bg-background/98 shadow-md backdrop-blur-xs"
          >
            <div className="divide-y divide-border/60">
              {group.annotations.map((annotation) =>
                annotationAdapter.renderCustomAnnotation ? (
                  <div key={annotation.id}>
                    {annotationAdapter.renderCustomAnnotation(annotation)}
                  </div>
                ) : (
                  <DiffCommentAnnotation
                    key={annotation.id}
                    environmentId={annotationAdapter.environmentId}
                    projectId={annotationAdapter.projectId}
                    kind="comment"
                    rangeLabel={annotation.rangeLabel}
                    text={annotation.body}
                    onCancel={() => undefined}
                    onComment={() => undefined}
                    {...(annotation.canDelete && annotationAdapter.deleteAnnotation
                      ? {
                          onDelete: () => {
                            void annotationAdapter.deleteAnnotation?.(entry, annotation.id);
                          },
                        }
                      : {})}
                  />
                ),
              )}

              {group.draft ? (
                <div className="relative">
                  <div className="flex items-center justify-between border-b border-border/50 bg-muted/25 px-3 py-1 text-3xs text-muted-foreground">
                    <span>
                      {gt("Comment on {range}", {
                        range: formatLineRangeLabel(
                          group.draft.side,
                          group.draft.startLine,
                          group.draft.endLine,
                        ),
                      })}
                    </span>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("Close comment box")}
                      onClick={closeDraft}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </div>
                  <DiffCommentAnnotation
                    environmentId={annotationAdapter.environmentId}
                    projectId={annotationAdapter.projectId}
                    ownerKey={`${entry.fileKey}:${group.draft.side}:${group.draft.startLine}-${group.draft.endLine}`}
                    kind="draft"
                    rangeLabel={formatLineRangeLabel(
                      group.draft.side,
                      group.draft.startLine,
                      group.draft.endLine,
                    )}
                    text={draftText}
                    onTextChange={setDraftText}
                    onCancel={closeDraft}
                    onComment={(text) => {
                      const activeDraft = group.draft;
                      if (!activeDraft) return;
                      void annotationAdapter.submitAnnotation({
                        entry,
                        side: activeDraft.side,
                        startLine: activeDraft.startLine,
                        endLine: activeDraft.endLine,
                        text,
                        oldText,
                        newText,
                      });
                      closeDraft();
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
