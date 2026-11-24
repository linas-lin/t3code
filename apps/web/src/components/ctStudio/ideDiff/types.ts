import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ReactNode } from "react";

export type IdeDiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export type IdeDiffViewMode = "split" | "unified";

export type IdeDiffTreeViewMode = "tree" | "flat";

export interface IdeDiffFileEntry {
  readonly fileKey: string;
  readonly path: string;
  readonly previousPath?: string | undefined;
  readonly status: IdeDiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly isTest: boolean;
  readonly isBinary?: boolean | undefined;
  readonly isImage?: boolean | undefined;
  readonly repositoryName?: string | undefined;
  readonly repositoryRoot?: string | undefined;
  /** Underlying Pierre metadata used for patch-only fallback and comment anchoring. */
  readonly fileDiff?: FileDiffMetadata | undefined;
}

export type IdeDiffLoadedContent =
  | {
      readonly kind: "text";
      readonly oldText: string;
      readonly newText: string;
      readonly language: string;
      /** True when reconstructed from patch hunks (e.g. checkpoints / tool calls) rather than full files. */
      readonly partial?: boolean | undefined;
      readonly oldLabel?: string | undefined;
      readonly newLabel?: string | undefined;
    }
  | {
      readonly kind: "binary";
      readonly reason: string;
      readonly isImage?: boolean | undefined;
    }
  | {
      readonly kind: "too-large";
      readonly reason: string;
      readonly byteSize?: number | undefined;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly retryable: boolean;
    };

export interface IdeDiffContentProvider {
  readonly cacheScopeKey: string;
  loadFileContent(entry: IdeDiffFileEntry, signal: AbortSignal): Promise<IdeDiffLoadedContent>;
}

export type IdeDiffAnnotationSide = "original" | "modified";

export interface IdeDiffInlineAnnotation {
  readonly id: string;
  readonly side: IdeDiffAnnotationSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly rangeLabel: string;
  readonly author?: string | undefined;
  readonly body: string;
  readonly status?: "draft" | "submitted" | "resolved" | undefined;
  readonly canDelete?: boolean | undefined;
}

export interface IdeDiffSubmitAnnotationInput {
  readonly entry: IdeDiffFileEntry;
  readonly side: IdeDiffAnnotationSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  readonly oldText: string;
  readonly newText: string;
}

/**
 * Extensible annotation adapter:
 * - P2: ComposerAnnotationAdapter (writes to useComposerDraftStore)
 * - P3: PullRequestAnnotationAdapter (renders & replies to GitHub/GitLab PR review threads)
 */
export interface IdeDiffAnnotationAdapter {
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | null | undefined;
  getAnnotations(entry: IdeDiffFileEntry): ReadonlyArray<IdeDiffInlineAnnotation>;
  submitAnnotation(input: IdeDiffSubmitAnnotationInput): Promise<void> | void;
  deleteAnnotation?(entry: IdeDiffFileEntry, annotationId: string): Promise<void> | void;
  renderCustomAnnotation?(annotation: IdeDiffInlineAnnotation): ReactNode;
}

export interface IdeDiffHunkChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

/**
 * Reserved P3 contract for in-diff editing and single-hunk revert.
 * When omitted (P1/P2), the Monaco Diff Editor runs strictly read-only.
 */
export interface IdeDiffEditAdapter {
  canEdit(entry: IdeDiffFileEntry): boolean;
  saveFile(entry: IdeDiffFileEntry, nextContent: string): Promise<void>;
  revertHunk?(entry: IdeDiffFileEntry, change: IdeDiffHunkChange): Promise<void>;
}

export interface IdeDiffChangeNavigationState {
  readonly currentIndex: number;
  readonly totalCount: number;
}

export interface IdeDiffViewportHandle {
  goToNextChange(): boolean;
  goToPreviousChange(): boolean;
  goToChange(index: number): void;
  focusFind(): void;
  getCurrentLineNumber(): number | null;
}

export interface IdeDiffOpenFileTarget {
  readonly entry: IdeDiffFileEntry;
  readonly lineNumber?: number | undefined;
}
