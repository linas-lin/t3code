import { msg, useGT } from "gt-react";
import { AlertTriangleIcon, PowerOffIcon, RefreshCwIcon } from "lucide-react";
import { Component, useState, type ErrorInfo, type ReactNode } from "react";

import { m } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { usePluginStore } from "./pluginStore";

export interface PluginErrorFallbackProps {
  readonly pluginId: string;
  readonly pluginName?: string | undefined;
  readonly slot?: string | undefined;
  readonly errorMessage: string;
  readonly compact?: boolean | undefined;
  readonly onReload: () => void | Promise<void>;
  readonly onDisable: () => void | Promise<void>;
}

export function PluginErrorFallback({
  pluginId,
  pluginName,
  slot,
  errorMessage,
  compact = false,
  onReload,
  onDisable,
}: PluginErrorFallbackProps) {
  const gt = useGT();
  const [busyAction, setBusyAction] = useState<"reload" | "disable" | null>(null);
  const label = pluginName || pluginId;

  const handleReload = () => {
    setBusyAction("reload");
    void Promise.resolve(onReload()).finally(() => {
      setBusyAction((current) => (current === "reload" ? null : current));
    });
  };

  const handleDisable = () => {
    setBusyAction("disable");
    void Promise.resolve(onDisable()).finally(() => {
      setBusyAction((current) => (current === "disable" ? null : current));
    });
  };

  if (compact) {
    return (
      <div
        role="alert"
        data-plugin-error-boundary={pluginId}
        data-plugin-error-slot={slot}
        className="rounded-xl border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-foreground"
      >
        <div className="flex items-start gap-2">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">
              {gt("Plugin {name} failed to render", { name: label })}
            </p>
            <p className="mt-0.5 break-words font-mono text-3xs text-muted-foreground">
              {errorMessage}
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={busyAction !== null} onClick={handleReload}>
            <RefreshCwIcon
              className={cn("size-3", busyAction === "reload" && "animate-spin")}
              aria-hidden
            />
            <span>{gt("Reload plugin")}</span>
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busyAction !== null}
            onClick={handleDisable}
          >
            <PowerOffIcon className="size-3" aria-hidden />
            <span>{gt("Disable plugin")}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-plugin-error-boundary={pluginId}
      data-plugin-error-slot={slot}
      className="flex h-full w-full flex-1 items-center justify-center p-6"
    >
      <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
            <AlertTriangleIcon className="size-4.5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">
              {gt("Plugin {name} crashed", { name: label })}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {slot
                ? gt("An unexpected error occurred in the {slot} slot.", { slot })
                : gt("An unexpected error occurred while rendering this plugin.")}
            </p>
          </div>
        </div>
        <pre className="mt-3 max-h-36 overflow-auto rounded-lg border border-border/70 bg-muted/40 p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {errorMessage}
        </pre>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={busyAction !== null}
            onClick={handleDisable}
          >
            <PowerOffIcon className="size-3.5" aria-hidden />
            <span>{gt("Disable plugin")}</span>
          </Button>
          <Button size="sm" variant="default" disabled={busyAction !== null} onClick={handleReload}>
            <RefreshCwIcon
              className={cn("size-3.5", busyAction === "reload" && "animate-spin")}
              aria-hidden
            />
            <span>{gt("Reload plugin")}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface PluginErrorBoundaryProps {
  readonly pluginId: string;
  readonly pluginName?: string | undefined;
  readonly slot?: string | undefined;
  readonly compact?: boolean | undefined;
  readonly resetKey?: string | number | undefined;
  readonly onReload?: (() => void | Promise<void>) | undefined;
  readonly onDisable?: (() => void | Promise<void>) | undefined;
  readonly children: ReactNode;
}

interface PluginErrorBoundaryState {
  readonly hasError: boolean;
  readonly errorMessage: string | null;
  readonly prevResetKey: string | number | undefined;
}

const UNKNOWN_PLUGIN_ERROR_MESSAGE = msg("Unknown plugin render error");

function formatThrownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return m(UNKNOWN_PLUGIN_ERROR_MESSAGE);
}

export class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  static getDerivedStateFromError(error: unknown): Partial<PluginErrorBoundaryState> {
    return {
      hasError: true,
      errorMessage: formatThrownError(error),
    };
  }

  static getDerivedStateFromProps(
    nextProps: PluginErrorBoundaryProps,
    prevState: PluginErrorBoundaryState,
  ): Partial<PluginErrorBoundaryState> | null {
    if (nextProps.resetKey !== prevState.prevResetKey) {
      return {
        hasError: false,
        errorMessage: null,
        prevResetKey: nextProps.resetKey,
      };
    }
    return null;
  }

  constructor(props: PluginErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: null,
      prevResetKey: props.resetKey,
    };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ct-plugin] ErrorBoundary caught render failure", {
      pluginId: this.props.pluginId,
      slot: this.props.slot,
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  private readonly handleReload = async (): Promise<void> => {
    this.setState({ hasError: false, errorMessage: null });
    if (this.props.onReload) {
      await this.props.onReload();
      return;
    }
    await usePluginStore.getState().reloadPlugin(this.props.pluginId);
  };

  private readonly handleDisable = async (): Promise<void> => {
    if (this.props.onDisable) {
      await this.props.onDisable();
      return;
    }
    await usePluginStore.getState().enablePlugin(this.props.pluginId, false);
  };

  override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <PluginErrorFallback
        pluginId={this.props.pluginId}
        pluginName={this.props.pluginName}
        slot={this.props.slot}
        errorMessage={this.state.errorMessage ?? m(UNKNOWN_PLUGIN_ERROR_MESSAGE)}
        compact={this.props.compact}
        onReload={this.handleReload}
        onDisable={this.handleDisable}
      />
    );
  }
}
