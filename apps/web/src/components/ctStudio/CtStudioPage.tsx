export interface CtStudioSearch {
  readonly ticket?: string | undefined;
  readonly stage?: string | undefined;
  readonly itemId?: string | undefined;
}

export function ctStudioSearchFromUrl(raw: Record<string, unknown>): CtStudioSearch {
  const ticket = typeof raw.ticket === "string" ? raw.ticket.trim().slice(0, 64) : "";
  const stage = typeof raw.stage === "string" ? raw.stage.trim().slice(0, 32) : "";
  const itemId = typeof raw.itemId === "string" ? raw.itemId.trim().slice(0, 128) : "";
  return {
    ...(ticket ? { ticket } : {}),
    ...(stage ? { stage } : {}),
    ...(itemId ? { itemId } : {}),
  };
}

export function CtStudioPage() {
  // The persistent iframe is rendered by CtStudioKeepAliveLayer in _chat.tsx so switching
  // back and forth between threads and CT Studio preserves scroll and form state.
  return null;
}
