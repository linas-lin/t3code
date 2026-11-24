import type { FileDiffMetadata } from "@pierre/diffs";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ReviewDiffChangeType,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffFileStat,
  ReviewDiffPreviewSourceKind,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/mediaPreview";
import { useGT } from "gt-react";
import type { MouseEvent, ReactNode } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { nextFileCommentId } from "../../files/fileCommentAnnotations";
import { IdeDiffWorkspace } from "./IdeDiffWorkspace";
import {
  checkTextContentSafety,
  inferMonacoLanguage,
  reconstructPatchSides,
} from "./patchFallback.logic";
import type {
  IdeDiffAnnotationAdapter,
  IdeDiffContentProvider,
  IdeDiffFileEntry,
  IdeDiffFileStatus,
  IdeDiffInlineAnnotation,
  IdeDiffLoadedContent,
  IdeDiffOpenFileTarget,
  IdeDiffSubmitAnnotationInput,
  IdeDiffViewMode,
} from "./types";

const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

type GetDiffFileContents<E = unknown> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

export interface GitIdeDiffSourceConfig {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly cacheKey: string;
  readonly getDiffFileContents: GetDiffFileContents;
}

export interface GitIdeDiffAdapterProps {
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly scopeKey: string;
  readonly scopeTitle: string;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly files: ReadonlyArray<{
    readonly fileDiff: FileDiffMetadata;
    readonly fileKey: string;
  }>;
  readonly fileStats: ReadonlyMap<string, ReviewDiffFileStat>;
  readonly gitSource?: GitIdeDiffSourceConfig | undefined;
  readonly selectedFilePath?: string | null | undefined;
  readonly resolvedTheme: "light" | "dark";
  readonly diffLayout: IdeDiffViewMode;
  readonly onDiffLayoutChange: (layout: IdeDiffViewMode) => void;
  readonly ignoreWhitespace: boolean;
  readonly onIgnoreWhitespaceChange: (ignore: boolean) => void;
  readonly wordWrap: boolean;
  readonly onWordWrapChange: (wrap: boolean) => void;
  readonly hideTestFiles: boolean;
  readonly onHideTestFilesChange: (hide: boolean) => void;
  readonly testFileCount: number;
  readonly onOpenFile: (target: IdeDiffOpenFileTarget) => void;
  readonly onFileContextMenu?: (entry: IdeDiffFileEntry, event: MouseEvent<HTMLElement>) => void;
  readonly onSwitchToClassic: () => void;
  readonly banner?: ReactNode;
}

function mapChangeTypeToStatus(
  changeType: ReviewDiffChangeType | FileDiffMetadata["type"] | undefined,
): IdeDiffFileStatus {
  switch (changeType) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    default:
      return "modified";
  }
}

function mapStatusToChangeType(
  entry: IdeDiffFileEntry,
  stat: ReviewDiffFileStat | undefined,
): ReviewDiffChangeType {
  if (stat?.changeType) return stat.changeType;
  const metaType = entry.fileDiff?.type;
  if (
    metaType === "new" ||
    metaType === "deleted" ||
    metaType === "rename-pure" ||
    metaType === "rename-changed" ||
    metaType === "change"
  ) {
    return metaType;
  }
  switch (entry.status) {
    case "added":
      return "new";
    case "deleted":
      return "deleted";
    case "renamed":
      return entry.additions === 0 && entry.deletions === 0 ? "rename-pure" : "rename-changed";
    default:
      return "change";
  }
}

function countFileDiffStats(fileDiff: FileDiffMetadata): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    for (const segment of hunk.hunkContent) {
      if (segment.type === "change") {
        additions += segment.additions;
        deletions += segment.deletions;
      }
    }
  }
  return { additions, deletions };
}

function buildFallbackReviewComment(
  input: IdeDiffSubmitAnnotationInput,
  sectionId: string,
  sectionTitle: string,
  id: string,
): ReviewCommentContext {
  const startLine = Math.max(1, Math.min(input.startLine, input.endLine));
  const endLine = Math.max(startLine, Math.max(input.startLine, input.endLine));
  const sourceText = input.side === "original" ? input.oldText : input.newText;
  const lines = sourceText.split("\n").slice(startLine - 1, endLine);
  const marker = input.side === "original" ? "-" : "+";
  const selectionSide = input.side === "original" ? "deletions" : "additions";
  const rangeLabel =
    startLine === endLine
      ? `${marker}${startLine}`
      : `${marker}${startLine} to ${marker}${endLine}`;
  const oldRange = input.side === "original" ? `${startLine},${lines.length}` : `0,0`;
  const newRange = input.side === "modified" ? `${startLine},${lines.length}` : `0,0`;

  return {
    id,
    sectionId,
    sectionTitle,
    filePath: input.entry.path,
    startIndex: startLine - 1,
    endIndex: endLine - 1,
    rangeLabel,
    text: input.text.trim(),
    diff: [`@@ -${oldRange} +${newRange} @@`, ...lines.map((line) => `${marker}${line}`)].join(
      "\n",
    ),
    fenceLanguage: "diff",
    selection: {
      start: startLine,
      side: selectionSide,
      end: endLine,
      endSide: selectionSide,
    },
  };
}

function focusActiveChatComposer(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  window.requestAnimationFrame(() => {
    const form = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]');
    if (!form) return;
    const editable = form.querySelector<HTMLElement>(
      '[contenteditable="true"], textarea, [role="textbox"]',
    );
    if (editable) {
      editable.scrollIntoView({ block: "nearest" });
      editable.focus();
    }
  });
}

export default function GitIdeDiffAdapter({
  environmentId,
  projectId,
  scopeKey,
  scopeTitle,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  files,
  fileStats,
  gitSource,
  selectedFilePath,
  resolvedTheme,
  diffLayout,
  onDiffLayoutChange,
  ignoreWhitespace,
  onIgnoreWhitespaceChange,
  wordWrap,
  onWordWrapChange,
  hideTestFiles,
  onHideTestFilesChange,
  testFileCount,
  onOpenFile,
  onFileContextMenu,
  onSwitchToClassic,
  banner,
}: GitIdeDiffAdapterProps) {
  const gt = useGT();
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );

  const entries: ReadonlyArray<IdeDiffFileEntry> = files.map(({ fileDiff, fileKey }) => {
    const path = resolveFileDiffPath(fileDiff);
    const previousPathRaw = resolveFileDiffPreviousPath(fileDiff);
    const previousPath = previousPathRaw && previousPathRaw !== path ? previousPathRaw : undefined;
    const stat = fileStats.get(path);
    const computedStats = stat
      ? { additions: stat.additions, deletions: stat.deletions }
      : countFileDiffStats(fileDiff);
    const isImage = isWorkspaceImagePreviewPath(path);
    return {
      fileKey,
      path,
      previousPath: stat?.previousPath ?? previousPath,
      status: mapChangeTypeToStatus(stat?.changeType ?? fileDiff.type),
      additions: computedStats.additions,
      deletions: computedStats.deletions,
      isTest: isTestChangedFile(path),
      isImage,
      fileDiff,
    };
  });

  const contentProvider: IdeDiffContentProvider = {
    cacheScopeKey: gitSource ? `${scopeKey}:${gitSource.cacheKey}` : `${scopeKey}:patch`,
    async loadFileContent(entry, signal): Promise<IdeDiffLoadedContent> {
      if (entry.isImage) {
        return {
          kind: "binary",
          isImage: true,
          reason: gt("Image files cannot be compared as text in the IDE diff view."),
        };
      }

      if (gitSource) {
        const stat = fileStats.get(entry.path);
        const changeType = mapStatusToChangeType(entry, stat);
        const oldPath = entry.previousPath ?? entry.path;
        try {
          const result = await gitSource.getDiffFileContents({
            environmentId: gitSource.environmentId,
            input: {
              cwd: gitSource.cwd,
              sourceKind: gitSource.sourceKind,
              changeType,
              baseRef: gitSource.baseRef,
              headRef: gitSource.headRef,
              oldPath,
              newPath: entry.path,
            },
          });
          if (signal.aborted) {
            return { kind: "error", message: gt("Request cancelled."), retryable: true };
          }
          if (result._tag === "Success") {
            const oldText =
              changeType === "rename-pure" ? result.value.newContents : result.value.oldContents;
            const newText = result.value.newContents;
            const safety = checkTextContentSafety(oldText, newText);
            if (!safety.ok) {
              if (safety.reason === "binary") {
                return {
                  kind: "binary",
                  reason: gt("Binary file cannot be displayed in the text diff editor."),
                };
              }
              return {
                kind: "too-large",
                byteSize: safety.byteSize,
                reason:
                  safety.reason === "long-line"
                    ? gt(
                        "This file contains minified or very long lines that may slow down the editor.",
                      )
                    : gt("This file exceeds the 2 MB inline diff size limit."),
              };
            }
            return {
              kind: "text",
              oldText,
              newText,
              language: inferMonacoLanguage(entry.path),
              oldLabel: gitSource.baseRef ?? gt("Original"),
              newLabel:
                gitSource.sourceKind === "working-tree"
                  ? gt("Working tree")
                  : (gitSource.headRef ?? gt("Modified")),
            };
          }
          // Fall through to patch reconstruction if fileDiff already has hunks; otherwise surface error.
          if (!entry.fileDiff || entry.fileDiff.hunks.length === 0) {
            const failure = squashAtomCommandFailure(result);
            return {
              kind: "error",
              message:
                failure instanceof Error
                  ? failure.message
                  : gt("Unable to load file contents for this diff."),
              retryable: true,
            };
          }
        } catch (error) {
          if (signal.aborted) {
            return { kind: "error", message: gt("Request cancelled."), retryable: true };
          }
          if (!entry.fileDiff || entry.fileDiff.hunks.length === 0) {
            return {
              kind: "error",
              message:
                error instanceof Error
                  ? error.message
                  : gt("Unable to load file contents for this diff."),
              retryable: true,
            };
          }
        }
      }

      if (entry.fileDiff) {
        const reconstructed = reconstructPatchSides(entry.fileDiff);
        const safety = checkTextContentSafety(reconstructed.oldText, reconstructed.newText);
        if (!safety.ok) {
          if (safety.reason === "binary") {
            return {
              kind: "binary",
              reason: gt("Binary file cannot be displayed in the text diff editor."),
            };
          }
          return {
            kind: "too-large",
            byteSize: safety.byteSize,
            reason: gt("This diff exceeds the inline editor safety limit."),
          };
        }
        return {
          kind: "text",
          oldText: reconstructed.oldText,
          newText: reconstructed.newText,
          language: inferMonacoLanguage(entry.path),
          partial: true,
        };
      }

      return {
        kind: "error",
        message: gt("No diff content is available for this file."),
        retryable: true,
      };
    },
  };

  const annotationAdapter: IdeDiffAnnotationAdapter = {
    environmentId,
    projectId,
    getAnnotations(entry): ReadonlyArray<IdeDiffInlineAnnotation> {
      return reviewComments
        .filter(
          (comment) =>
            comment.sectionId === sectionId &&
            comment.filePath === entry.path &&
            (comment.fenceLanguage ?? "diff") === "diff",
        )
        .map((comment): IdeDiffInlineAnnotation | null => {
          const restored =
            comment.selection ??
            (entry.fileDiff ? restoreDiffReviewCommentRange(entry.fileDiff, comment) : null);
          const side =
            (restored?.endSide ?? restored?.side) === "deletions" ? "original" : "modified";
          const startLine = restored?.start ?? Math.max(1, comment.startIndex + 1);
          const endLine = restored?.end ?? Math.max(startLine, comment.endIndex + 1);
          return {
            id: comment.id,
            side,
            startLine: Math.min(startLine, endLine),
            endLine: Math.max(startLine, endLine),
            rangeLabel: comment.rangeLabel,
            body: comment.text,
            status: "draft",
            canDelete: true,
          };
        })
        .filter((item): item is IdeDiffInlineAnnotation => item !== null);
    },
    submitAnnotation(input) {
      const id = nextFileCommentId();
      const selectionSide = input.side === "original" ? "deletions" : "additions";
      const diffComment =
        input.entry.fileDiff && input.entry.fileDiff.hunks.length > 0
          ? buildDiffReviewComment({
              id,
              sectionId,
              sectionTitle,
              filePath: input.entry.path,
              fileDiff: input.entry.fileDiff,
              range: {
                start: input.startLine,
                side: selectionSide,
                end: input.endLine,
                endSide: selectionSide,
              },
              text: input.text,
            })
          : null;
      const record = diffComment ?? buildFallbackReviewComment(input, sectionId, sectionTitle, id);
      addReviewComment(composerDraftTarget, record);
    },
    deleteAnnotation(_entry, annotationId) {
      removeReviewComment(composerDraftTarget, annotationId);
    },
  };

  const sectionCommentCount = reviewComments.filter(
    (comment) => comment.sectionId === sectionId && (comment.fenceLanguage ?? "diff") === "diff",
  ).length;

  return (
    <IdeDiffWorkspace
      scopeKey={scopeKey}
      scopeTitle={scopeTitle}
      entries={entries}
      selectedFilePath={selectedFilePath}
      contentProvider={contentProvider}
      annotationAdapter={annotationAdapter}
      resolvedTheme={resolvedTheme}
      diffLayout={diffLayout}
      onDiffLayoutChange={onDiffLayoutChange}
      ignoreWhitespace={ignoreWhitespace}
      onIgnoreWhitespaceChange={onIgnoreWhitespaceChange}
      wordWrap={wordWrap}
      onWordWrapChange={onWordWrapChange}
      hideTestFiles={hideTestFiles}
      onHideTestFilesChange={onHideTestFilesChange}
      testFileCount={testFileCount}
      onOpenExternal={onOpenFile}
      onFileContextMenu={onFileContextMenu}
      onSwitchToClassic={onSwitchToClassic}
      pendingCommentCount={sectionCommentCount}
      onFocusComposer={focusActiveChatComposer}
      banner={banner}
    />
  );
}
