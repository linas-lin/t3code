import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { InboxIcon, LayoutGridIcon } from "lucide-react";
import { memo } from "react";

import { useThreadShell } from "~/state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveThreadCtStudioLink } from "./ctStudioBridge";
import { useCtStudioStore } from "./ctStudioStore";

export const ThreadCtStudioButton = memo(function ThreadCtStudioButton({
  threadRef,
  title,
  branch,
}: {
  threadRef?: ScopedThreadRef | null | undefined;
  title: string;
  branch?: string | null | undefined;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const connected = useCtStudioStore((state) => state.connected);
  const workspaceContext = useCtStudioStore((state) => state.workspaceContext);
  const thread = useThreadShell(threadRef ?? null);
  if (!connected) return null;
  const resolved = resolveThreadCtStudioLink(
    {
      id: threadRef?.threadId,
      title,
      branch,
      rootThreadId: thread?.lineage?.rootThreadId,
    },
    workspaceContext,
  );
  if (!resolved) return null;

  const isInbox = resolved.link.kind === "inbox";
  const label = isInbox ? resolved.link.source : resolved.link.ticketKey;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={
              isInbox
                ? gt("Open {label} in CT Studio Inbox", { label })
                : gt("Open {ticketKey} in CT Studio", { ticketKey: label })
            }
            onClick={() => {
              if (resolved.link.kind === "inbox") {
                void navigate({ to: "/ct-studio", search: { itemId: resolved.link.itemId } });
              } else {
                void navigate({
                  to: "/ct-studio",
                  search: {
                    ticket: resolved.link.ticketKey,
                    ...(resolved.link.stage ? { stage: resolved.link.stage } : {}),
                  },
                });
              }
            }}
            className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag]"
          >
            {isInbox ? <InboxIcon className="size-3" /> : <LayoutGridIcon className="size-3" />}
            <span>{label}</span>
          </button>
        }
      />
      <TooltipPopup side="bottom">
        {isInbox ? (
          <T>
            Open <Var>{resolved.link.title}</Var> in CT Studio
          </T>
        ) : (
          <T>
            Open <Var>{label}</Var> in CT Studio
          </T>
        )}
      </TooltipPopup>
    </Tooltip>
  );
});
