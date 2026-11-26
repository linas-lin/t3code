import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";

import { useThreadShell } from "~/state/entities";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { usePluginStore } from "./pluginStore";
import { PLUGIN_UI_KIT } from "./pluginUiKit";

function useHasPluginThreadPanelCards(): boolean {
  return usePluginStore((state) =>
    state.plugins.some((plugin) => {
      if (!plugin.enabled) return false;
      const runtime = state.runtimeById[plugin.id];
      return (
        runtime?.status === "loaded" &&
        Boolean(runtime.registration?.threadPanel?.Card) &&
        Boolean(runtime.host)
      );
    }),
  );
}

function useHasPluginThreadPopoverRows(): boolean {
  return usePluginStore((state) =>
    state.plugins.some((plugin) => {
      if (!plugin.enabled) return false;
      const runtime = state.runtimeById[plugin.id];
      return (
        runtime?.status === "loaded" &&
        Boolean(runtime.registration?.threadPanel?.PopoverRow) &&
        Boolean(runtime.host)
      );
    }),
  );
}

export function useThreadPluginDecorations({
  threadRef,
  legacyBelowCard,
  legacyPopoverFooter,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly legacyBelowCard?: ReactNode;
  readonly legacyPopoverFooter?: ReactNode;
}): {
  readonly belowCard: ReactNode | undefined;
  readonly popoverFooter: ReactNode | undefined;
} {
  const hasPluginCards = useHasPluginThreadPanelCards();
  const hasPluginPopoverRows = useHasPluginThreadPopoverRows();

  const belowCard =
    legacyBelowCard || hasPluginCards ? (
      <>
        {legacyBelowCard ?? null}
        {hasPluginCards ? <PluginThreadPanelSlots threadRef={threadRef} /> : null}
      </>
    ) : undefined;

  const popoverFooter =
    legacyPopoverFooter || hasPluginPopoverRows ? (
      <>
        {legacyPopoverFooter ?? null}
        {hasPluginPopoverRows ? <PluginThreadPopoverSlots threadRef={threadRef} /> : null}
      </>
    ) : undefined;

  return { belowCard, popoverFooter };
}

const PluginThreadPanelSlots = memo(function PluginThreadPanelSlots({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef;
}) {
  const plugins = usePluginStore((state) => state.plugins);
  const runtimeById = usePluginStore((state) => state.runtimeById);
  const thread = useThreadShell(threadRef);

  const cards = plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    const runtime = runtimeById[plugin.id];
    const Card = runtime?.registration?.threadPanel?.Card;
    if (runtime?.status !== "loaded" || !Card || !runtime.host) return [];
    return [{ plugin, runtime, Card, host: runtime.host }];
  });

  if (cards.length === 0) return null;

  return (
    <>
      {cards.map(({ plugin, runtime, Card, host }) => (
        <PluginErrorBoundary
          key={plugin.id}
          pluginId={plugin.id}
          pluginName={plugin.manifest?.name ?? plugin.id}
          slot="threadPanel"
          compact
          resetKey={runtime.loadedNonce ?? plugin.reloadNonce}
        >
          <Card
            pluginId={plugin.id}
            threadId={threadRef.threadId}
            environmentId={threadRef.environmentId}
            projectId={thread?.projectId}
            title={thread?.title}
            branch={thread?.branch}
            worktreePath={thread?.worktreePath}
            rootThreadId={thread?.lineage?.rootThreadId ?? null}
            host={host}
            uiKit={PLUGIN_UI_KIT}
          />
        </PluginErrorBoundary>
      ))}
    </>
  );
});

const PluginThreadPopoverSlots = memo(function PluginThreadPopoverSlots({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef;
}) {
  const plugins = usePluginStore((state) => state.plugins);
  const runtimeById = usePluginStore((state) => state.runtimeById);
  const thread = useThreadShell(threadRef);

  const rows = plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    const runtime = runtimeById[plugin.id];
    const PopoverRow = runtime?.registration?.threadPanel?.PopoverRow;
    if (runtime?.status !== "loaded" || !PopoverRow || !runtime.host) return [];
    return [{ plugin, runtime, PopoverRow, host: runtime.host }];
  });

  if (rows.length === 0) return null;

  return (
    <>
      {rows.map(({ plugin, runtime, PopoverRow, host }) => (
        <PluginErrorBoundary
          key={plugin.id}
          pluginId={plugin.id}
          pluginName={plugin.manifest?.name ?? plugin.id}
          slot="threadPanelPopover"
          compact
          resetKey={runtime.loadedNonce ?? plugin.reloadNonce}
        >
          <PopoverRow
            pluginId={plugin.id}
            threadId={threadRef.threadId}
            environmentId={threadRef.environmentId}
            projectId={thread?.projectId}
            title={thread?.title}
            branch={thread?.branch}
            worktreePath={thread?.worktreePath}
            rootThreadId={thread?.lineage?.rootThreadId ?? null}
            host={host}
            uiKit={PLUGIN_UI_KIT}
          />
        </PluginErrorBoundary>
      ))}
    </>
  );
});

export const PluginThreadBannerSlots = memo(function PluginThreadBannerSlots({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef | null;
}) {
  const plugins = usePluginStore((state) => state.plugins);
  const runtimeById = usePluginStore((state) => state.runtimeById);

  if (!threadRef) return null;

  const banners = plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    const runtime = runtimeById[plugin.id];
    const Banner = runtime?.registration?.threadBanner;
    if (runtime?.status !== "loaded" || !Banner || !runtime.host) return [];
    return [{ plugin, runtime, Banner, host: runtime.host }];
  });

  if (banners.length === 0) return null;

  return (
    <div data-slot="plugin-thread-banners" className="mb-2 space-y-2">
      {banners.map(({ plugin, runtime, Banner, host }) => (
        <PluginErrorBoundary
          key={plugin.id}
          pluginId={plugin.id}
          pluginName={plugin.manifest?.name ?? plugin.id}
          slot="threadBanner"
          compact
          resetKey={runtime.loadedNonce ?? plugin.reloadNonce}
        >
          <Banner
            pluginId={plugin.id}
            threadId={threadRef.threadId}
            environmentId={threadRef.environmentId}
            host={host}
            uiKit={PLUGIN_UI_KIT}
          />
        </PluginErrorBoundary>
      ))}
    </div>
  );
});
