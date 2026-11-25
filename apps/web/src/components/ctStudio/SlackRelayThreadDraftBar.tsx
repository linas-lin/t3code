import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  discardSlackRelayDraft,
  fetchSlackRelaySnapshot,
  sendSlackRelayDraft,
  type SlackRelayPendingDraft,
} from "./slackRelayClient";

export function SlackRelayThreadDraftBar({ threadId }: { readonly threadId: string | null }) {
  const gt = useGT();
  const [drafts, setDrafts] = useState<ReadonlyArray<SlackRelayPendingDraft>>([]);
  const [editedTextById, setEditedTextById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- poll pending Slack relay drafts for this thread
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    const poll = () => {
      void fetchSlackRelaySnapshot()
        .then((snapshot) => {
          if (cancelled) return;
          setDrafts(snapshot.pending.filter((item) => item.t3ThreadId === threadId));
        })
        .catch(() => {
          // Silently ignore when relay is unavailable
        });
    };
    poll();
    const timer = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId]);

  const visibleDrafts = threadId ? drafts.filter((item) => item.t3ThreadId === threadId) : [];
  if (visibleDrafts.length === 0) return null;

  const handleSend = async (draft: SlackRelayPendingDraft) => {
    setBusyId(draft.id);
    setError(null);
    try {
      const text = editedTextById[draft.id] ?? draft.replyText;
      const next = await sendSlackRelayDraft(draft.id, text);
      setDrafts(next.pending.filter((item) => item.t3ThreadId === threadId));
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Failed to send reply"));
    } finally {
      setBusyId(null);
    }
  };

  const handleDiscard = async (draftId: string) => {
    setBusyId(draftId);
    setError(null);
    try {
      const next = await discardSlackRelayDraft(draftId);
      setDrafts(next.pending.filter((item) => item.t3ThreadId === threadId));
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Failed to discard draft"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mb-2 space-y-2">
      {visibleDrafts.map((draft) => {
        const value = editedTextById[draft.id] ?? draft.replyText;
        const busy = busyId === draft.id;
        return (
          <div
            key={draft.id}
            className="rounded-xl border border-border bg-card/95 p-3 shadow-xs backdrop-blur-xs"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                <Badge variant="secondary" size="sm">
                  <T>Pending Slack reply</T>
                </Badge>
                <span className="font-mono text-muted-foreground">{draft.channel}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleDiscard(draft.id)}
                >
                  <T>Discard</T>
                </Button>
                <Button size="sm" disabled={busy} onClick={() => void handleSend(draft)}>
                  {busy ? gt("Sending...") : gt("Send to Slack")}
                </Button>
              </div>
            </div>
            <textarea
              value={value}
              onChange={(event) =>
                setEditedTextById((prev) => ({ ...prev, [draft.id]: event.target.value }))
              }
              rows={Math.min(Math.max(value.split("\n").length + 1, 3), 8)}
              className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
            {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
