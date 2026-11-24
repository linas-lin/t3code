import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { isMacPlatform } from "~/lib/utils";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { serverEnvironment } from "~/state/server";

import { nextFileCommentId } from "../../files/fileCommentAnnotations";
import { toastManager } from "../../ui/toast";
import { CodeExplorerEditor } from "./CodeExplorerEditor";
import { CodeExplorerResultsDrawer } from "./CodeExplorerResultsDrawer";
import { CodeExplorerScopeBar } from "./CodeExplorerScopeBar";
import { CodeExplorerSidebar } from "./CodeExplorerSidebar";
import { buildExplorerFileKey, useCodeExplorerStore } from "./codeExplorerStore";
import { joinRepoSubpath, pickInitialSelectedScopeIds } from "./repoScope.logic";
import { shouldAutoJumpDefinition } from "./symbolNavigation.logic";
import type { ExplorerFileTarget, ExplorerSearchMode, SymbolLocation } from "./types";
import { useAvailableRepoScopes } from "./useMultiRepoSearch";
import { useHeuristicSymbolNavigator } from "./useSymbolNavigation";

const MODE_CYCLE: ReadonlyArray<ExplorerSearchMode> = ["code", "files", "tree"];

export default function CodeExplorerOverlay() {
  const gt = useGT();
  const resolvedTheme = useRenderedAppearance();
  const activeProjectTarget = useActiveProjectTarget();
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);

  const open = useCodeExplorerStore((state) => state.open);
  const mode = useCodeExplorerStore((state) => state.mode);
  const focusSearchToken = useCodeExplorerStore((state) => state.focusSearchToken);
  const selectedScopeIds = useCodeExplorerStore((state) => state.selectedScopeIds);
  const hasExplicitScopeSelection = useCodeExplorerStore(
    (state) => state.hasExplicitScopeSelection,
  );
  const activeTarget = useCodeExplorerStore((state) => state.activeTarget);
  const history = useCodeExplorerStore((state) => state.history);
  const historyIndex = useCodeExplorerStore((state) => state.historyIndex);
  const drawer = useCodeExplorerStore((state) => state.drawer);

  const closeExplorer = useCodeExplorerStore((state) => state.closeExplorer);
  const setMode = useCodeExplorerStore((state) => state.setMode);
  const toggleScopeId = useCodeExplorerStore((state) => state.toggleScopeId);
  const setSelectedScopeIds = useCodeExplorerStore((state) => state.setSelectedScopeIds);
  const addCustomRepo = useCodeExplorerStore((state) => state.addCustomRepo);
  const removeCustomRepo = useCodeExplorerStore((state) => state.removeCustomRepo);
  const openFileTarget = useCodeExplorerStore((state) => state.openFileTarget);
  const navigateBack = useCodeExplorerStore((state) => state.navigateBack);
  const navigateForward = useCodeExplorerStore((state) => state.navigateForward);
  const setDrawer = useCodeExplorerStore((state) => state.setDrawer);

  const [sidebarWidth, setSidebarWidth] = useState(420);
  const [focusEditorToken, setFocusEditorToken] = useState(0);
  const { scopes, isDiscovering } = useAvailableRepoScopes(open);
  const symbolNavigator = useHeuristicSymbolNavigator();

  const defaultEnvironmentId =
    activeProjectTarget?.environmentId ?? scopes[0]?.environmentId ?? null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(defaultEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    defaultEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );

  const availableIdSet = new Set(scopes.map((scope) => scope.id));
  const effectiveSelectedScopeIds = hasExplicitScopeSelection
    ? selectedScopeIds.filter((id) => availableIdSet.has(id))
    : pickInitialSelectedScopeIds({
        available: scopes,
        activeCwd: activeProjectTarget?.cwd,
        activeEnvironmentId: activeProjectTarget?.environmentId,
      });

  const activeScopes = scopes.filter((scope) => effectiveSelectedScopeIds.includes(scope.id));

  const openLocation = (location: SymbolLocation) => {
    openFileTarget({
      repoId: location.repoId,
      repoName: location.repoName,
      cwd: location.cwd,
      environmentId: location.environmentId,
      relativePath: location.relativePath,
      lineNumber: location.lineNumber,
      column: location.column,
    });
  };

  const handleGoToDefinition = async (input: {
    readonly symbol: string;
    readonly qualifier?: string | undefined;
    readonly target: ExplorerFileTarget;
    readonly fileText: string;
    readonly language: string;
  }) => {
    setDrawer({
      kind: "definitions",
      symbol: input.symbol,
      loading: true,
      locations: [],
    });

    try {
      const locations = await symbolNavigator.findDefinitions({
        symbol: input.symbol,
        qualifier: input.qualifier,
        currentFile: input.target,
        currentFileText: input.fileText,
        language: input.language,
        scopes: activeScopes,
      });
      if (shouldAutoJumpDefinition(locations)) {
        const best = locations[0]!;
        setDrawer(null);
        openLocation(best);
      } else {
        setDrawer({
          kind: "definitions",
          symbol: input.symbol,
          loading: false,
          locations,
        });
      }
    } catch (error) {
      setDrawer({
        kind: "definitions",
        symbol: input.symbol,
        loading: false,
        locations: [],
        error: error instanceof Error ? error.message : gt("Definition lookup failed."),
      });
    }
  };

  const handleFindUsages = async (input: {
    readonly symbol: string;
    readonly target: ExplorerFileTarget;
  }) => {
    setDrawer({
      kind: "references",
      symbol: input.symbol,
      loading: true,
      locations: [],
    });

    try {
      const locations = await symbolNavigator.findReferences({
        symbol: input.symbol,
        currentFile: input.target,
        scopes: activeScopes,
      });
      setDrawer({
        kind: "references",
        symbol: input.symbol,
        loading: false,
        locations,
      });
    } catch (error) {
      setDrawer({
        kind: "references",
        symbol: input.symbol,
        loading: false,
        locations: [],
        error: error instanceof Error ? error.message : gt("Usage search failed."),
      });
    }
  };

  const handleSendToChat = activeProjectTarget?.threadRef
    ? (input: {
        readonly target: ExplorerFileTarget;
        readonly startLine: number;
        readonly endLine: number;
        readonly contents: string;
      }) => {
        const displayPath = `${input.target.repoName}/${input.target.relativePath}`;
        const record = buildFileReviewComment({
          id: nextFileCommentId(),
          filePath: displayPath,
          startLine: input.startLine,
          endLine: input.endLine,
          text: gt("Inspect {path} (L{start}-L{end})", {
            path: displayPath,
            start: input.startLine,
            end: input.endLine,
          }),
          contents: input.contents,
        });
        addReviewComment(activeProjectTarget.threadRef, record);
        toastManager.add({
          type: "success",
          title: gt("Added code snippet to chat composer"),
          description: `${displayPath}:${input.startLine}-${input.endLine}`,
        });
      }
    : undefined;

  const handleOpenExternal = (target: ExplorerFileTarget, lineNumber?: number) => {
    const absPath = joinRepoSubpath(target.cwd, target.relativePath);
    const withLine = lineNumber && lineNumber > 0 ? `${absPath}:${lineNumber}` : absPath;
    void openInPreferredEditor(withLine);
  };

  // Overlay-level IDEA navigation shortcuts: Cmd+[/], Cmd+Option+Left/Right, Cmd+W, Escape.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds overlay keyboard navigation while Code Explorer is open
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;

      if (
        event.key === "Tab" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.isComposing
      ) {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest(".find-widget, [data-code-explorer-allow-tab]")
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const currentMode = useCodeExplorerStore.getState().mode;
        const currentIndex = MODE_CYCLE.indexOf(currentMode);
        const step = event.shiftKey ? -1 : 1;
        const nextMode =
          MODE_CYCLE[(currentIndex + step + MODE_CYCLE.length) % MODE_CYCLE.length] ?? "code";
        setMode(nextMode);
        return;
      }

      if (event.key === "Escape") {
        // Let Monaco find widget or an active Tree filter handle its own Escape first.
        if (
          event.target instanceof HTMLElement &&
          event.target.closest(".find-widget, [data-code-explorer-escape-handled]")
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (useCodeExplorerStore.getState().drawer) {
          setDrawer(null);
        } else {
          closeExplorer();
        }
        return;
      }

      if (mod && !event.shiftKey) {
        if ((event.key === "[" && !event.altKey) || (event.altKey && event.key === "ArrowLeft")) {
          event.preventDefault();
          navigateBack();
          return;
        }
        if ((event.key === "]" && !event.altKey) || (event.altKey && event.key === "ArrowRight")) {
          event.preventDefault();
          navigateForward();
          return;
        }
        if (event.key.toLowerCase() === "w" && !event.altKey) {
          event.preventDefault();
          closeExplorer();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeExplorer, navigateBack, navigateForward, open, setDrawer, setMode]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={gt("Multi-Repo Code Explorer")}
      data-code-explorer-overlay
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <CodeExplorerScopeBar
        scopes={scopes}
        selectedScopeIds={effectiveSelectedScopeIds}
        defaultEnvironmentId={defaultEnvironmentId}
        defaultBrowseCwd={
          serverConfig?.newProjectsRoot ?? activeProjectTarget?.cwd ?? scopes[0]?.cwd ?? null
        }
        platformOs={serverConfig?.environment.platform.os}
        isDiscovering={isDiscovering}
        onToggleScope={(scopeId) => {
          if (!hasExplicitScopeSelection) {
            const exists = effectiveSelectedScopeIds.includes(scopeId);
            const next = exists
              ? effectiveSelectedScopeIds.filter((id) => id !== scopeId)
              : [...effectiveSelectedScopeIds, scopeId];
            setSelectedScopeIds(next);
          } else {
            toggleScopeId(scopeId);
          }
        }}
        onSelectOnlyScope={(scopeId) => setSelectedScopeIds([scopeId])}
        onSelectAllBusinessScopes={() =>
          setSelectedScopeIds(
            scopes.filter((scope) => !scope.isCtStudioRoot).map((scope) => scope.id),
          )
        }
        onClearScopes={() => setSelectedScopeIds([])}
        onAddCustomRepo={addCustomRepo}
        onRemoveCustomRepo={removeCustomRepo}
        onClose={closeExplorer}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <CodeExplorerSidebar
          open={open}
          mode={mode}
          focusSearchToken={focusSearchToken}
          scopes={activeScopes}
          activeTabKey={
            activeTarget
              ? buildExplorerFileKey(activeTarget.repoId, activeTarget.relativePath)
              : null
          }
          activeLineNumber={activeTarget?.lineNumber ?? null}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          onModeChange={setMode}
          onOpenTarget={openFileTarget}
          onFocusEditor={() => setFocusEditorToken((token) => token + 1)}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <CodeExplorerEditor
            activeTarget={activeTarget}
            focusEditorToken={focusEditorToken}
            resolvedTheme={resolvedTheme === "dark" ? "dark" : "light"}
            canGoBack={historyIndex > 0}
            canGoForward={historyIndex >= 0 && historyIndex < history.length - 1}
            onNavigateBack={() => {
              navigateBack();
            }}
            onNavigateForward={() => {
              navigateForward();
            }}
            onGoToDefinition={(input) => {
              void handleGoToDefinition(input);
            }}
            onFindUsages={(input) => {
              void handleFindUsages(input);
            }}
            onSendToChat={handleSendToChat}
            onOpenExternal={handleOpenExternal}
          />

          <CodeExplorerResultsDrawer
            drawer={drawer}
            onSelectLocation={openLocation}
            onClose={() => setDrawer(null)}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
