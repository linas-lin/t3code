// oxlint-disable-next-line eslint/no-restricted-imports -- plugin runtime exposes full lucide-react icon namespace to externalized plugins per spec 4.1
import type * as LucideIcons from "lucide-react";
import type * as React from "react";
import type { ComponentType } from "react";
import type * as ReactDOM from "react-dom";
import type * as jsxRuntime from "react/jsx-runtime";

import type { CtPluginUiKit } from "./pluginUiKit";

export type { CtPluginUiKit };

export const CT_PLUGIN_API_VERSION = 1 as const;

export type CtPluginPermission =
  | "threads"
  | "workspace"
  | "backend"
  | "network"
  | "mcp"
  | "host-callback";

export type CtPluginSlotName =
  | "mainView"
  | "threadPanel"
  | "threadBanner"
  | "settingsSection"
  | "commands";

export type CtPluginBackendActivation = "startup" | "lazy";

export interface CtPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly apiVersion: number;
  readonly ui?:
    | {
        readonly entry: string;
        readonly css?: string | undefined;
      }
    | undefined;
  readonly backend?:
    | {
        readonly activation?: CtPluginBackendActivation | undefined;
        readonly command: ReadonlyArray<string>;
        readonly healthcheck?: string | undefined;
        readonly cwd?: string | undefined;
      }
    | undefined;
  readonly build?:
    | {
        readonly command?: ReadonlyArray<string> | undefined;
      }
    | undefined;
  readonly permissions?: ReadonlyArray<CtPluginPermission> | undefined;
  readonly contributes?:
    | {
        readonly sidebar?:
          | {
              readonly label: string;
              readonly icon?: string | undefined;
              readonly shortcut?: string | undefined;
            }
          | undefined;
        readonly slots?: ReadonlyArray<CtPluginSlotName> | undefined;
      }
    | undefined;
}

export type PluginRecordSource =
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string | undefined;
      readonly commit?: string | undefined;
    }
  | {
      readonly kind: "local";
      readonly path: string;
    };

export type PluginBackendStatus = "none" | "stopped" | "starting" | "running" | "error";

export interface PluginRecordView {
  readonly id: string;
  readonly source: PluginRecordSource;
  readonly rootDir: string;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly reloadNonce: number;
  readonly manifest: CtPluginManifest | null;
  readonly manifestError: string | null;
  readonly uiReady: boolean;
  readonly backend: {
    readonly configured: boolean;
    readonly activation: CtPluginBackendActivation | null;
    readonly status: PluginBackendStatus;
    readonly error: string | null;
    readonly startedAt: string | null;
  };
}

export interface PluginListResponse {
  readonly apiVersion: 1;
  readonly plugins: ReadonlyArray<PluginRecordView>;
}

export type PluginInstallRequest =
  | {
      readonly source: "git";
      readonly url: string;
      readonly ref?: string | undefined;
      readonly runBuild?: boolean | undefined;
    }
  | {
      readonly source: "local";
      readonly path: string;
      readonly runBuild?: boolean | undefined;
    };

export interface PluginSingleResponse {
  readonly plugin: PluginRecordView;
}

export interface PluginUpdateResponse {
  readonly plugin: PluginRecordView;
  readonly updated: boolean;
  readonly commit?: string | undefined;
}

export interface PluginUninstallResponse {
  readonly uninstalled: string;
}

export interface PluginHostModelOptionChoice {
  readonly id: string;
  readonly label: string;
  readonly isDefault?: boolean | undefined;
}

export type PluginHostModelOption =
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "select";
      readonly options: ReadonlyArray<PluginHostModelOptionChoice>;
      readonly defaultValue?: string | undefined;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "boolean";
      readonly defaultValue?: boolean | undefined;
    };

export interface PluginHostModel {
  readonly slug: string;
  readonly name: string;
  readonly isDefault?: boolean | undefined;
  readonly options?: ReadonlyArray<PluginHostModelOption> | undefined;
}

export interface PluginHostProvider {
  readonly id: string;
  readonly driver: string;
  readonly name: string;
  readonly available: boolean;
  readonly models: ReadonlyArray<PluginHostModel>;
}

export interface PluginHostProject {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
}

export type PluginHostThreadStatus = "working" | "blocked" | "done" | "idle";

export interface PluginHostThread {
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: PluginHostThreadStatus;
  readonly providerId: string;
  readonly model?: string | undefined;
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly parentThreadId?: string | undefined;
  readonly rootThreadId?: string | undefined;
  readonly relationshipToParent?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface PluginHostWorkspaceSnapshot {
  readonly defaultProjectId?: string | undefined;
  readonly projects: ReadonlyArray<PluginHostProject>;
  readonly providers: ReadonlyArray<PluginHostProvider>;
  readonly editor: {
    readonly available: boolean;
    readonly label?: string | undefined;
  };
}

export interface PluginModelSelectionInput {
  readonly providerId: string;
  readonly modelSlug: string;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
}

export interface PluginStartThreadRequest {
  readonly projectId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly branch?: string | undefined;
  readonly prepareWorktree?:
    | {
        readonly baseBranch: string;
        readonly branch?: string | undefined;
        readonly startFromOrigin?: boolean | undefined;
      }
    | undefined;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection?: PluginModelSelectionInput | undefined;
  readonly interactionMode?: "default" | "plan" | undefined;
  readonly focus?: boolean | undefined;
  readonly group?: string | undefined;
}

export type PluginStartThreadResult =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly environmentId: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface PluginSendThreadRequest {
  readonly threadId: string;
  readonly environmentId?: string | undefined;
  readonly prompt: string;
  readonly title?: string | undefined;
  readonly focus?: boolean | undefined;
}

export type PluginSendThreadResult =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly environmentId: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface PluginPrepareWorktreeRequest {
  readonly cwd: string;
  readonly existingWorktreePath?: string | undefined;
  readonly branch?: string | undefined;
  readonly baseBranch?: string | undefined;
}

export type PluginPrepareWorktreeResult =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly worktreePath: string;
      readonly branch: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface PluginOpenDiffRequest {
  readonly threadId?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly branch?: string | undefined;
  readonly scope?: "unstaged" | "branch" | undefined;
  readonly commit?: string | undefined;
  readonly title?: string | undefined;
}

export type PluginOpenDiffResult =
  | {
      readonly ok: true;
      readonly threadId: string;
      readonly environmentId: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export type PluginOpenInEditorResult =
  | {
      readonly ok: true;
      readonly editor: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export interface PluginHeaderInset {
  readonly left: number;
  readonly right: number;
  readonly height?: number | undefined;
}

export interface PluginNavigationEvent {
  readonly subpath?: string | undefined;
  readonly search: Record<string, string>;
}

export interface PluginToastInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly type?: "info" | "success" | "warning" | "error" | undefined;
}

export interface CtPluginHostSdk {
  readonly apiVersion: 1;
  readonly hostInfo: {
    readonly id: string;
    readonly name: string;
  };
  readonly threads: {
    getSnapshot(): ReadonlyArray<PluginHostThread>;
    subscribe(listener: () => void): () => void;
    start(req: PluginStartThreadRequest): Promise<PluginStartThreadResult>;
    send(req: PluginSendThreadRequest): Promise<PluginSendThreadResult>;
    focus(threadId: string, environmentId?: string): boolean;
  };
  readonly workspace: {
    getSnapshot(): PluginHostWorkspaceSnapshot;
    subscribe(listener: () => void): () => void;
    prepareWorktree(req: PluginPrepareWorktreeRequest): Promise<PluginPrepareWorktreeResult>;
    openDiff(req: PluginOpenDiffRequest): Promise<PluginOpenDiffResult>;
    openInEditor(path: string): Promise<PluginOpenInEditorResult>;
  };
  readonly ui: {
    getTheme(): "light" | "dark";
    subscribeTheme(listener: () => void): () => void;
    getHeaderInset(): PluginHeaderInset;
    subscribeHeaderInset(listener: () => void): () => void;
    setBadge(count: number): void;
    navigateToPlugin(subpath?: string, search?: Record<string, string>): void;
    navigateToMainApp(): void;
    toast(input: PluginToastInput): void;
  };
  readonly api: {
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  readonly events: {
    onNavigate(handler: (nav: PluginNavigationEvent) => void): () => void;
  };
}

export interface PluginMainViewProps {
  readonly pluginId: string;
  readonly active: boolean;
  readonly search: Record<string, string>;
  readonly host: CtPluginHostSdk;
  readonly uiKit: CtPluginUiKit;
}

export interface PluginThreadSlotProps {
  readonly pluginId: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly projectId?: string | undefined;
  readonly title?: string | undefined;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly rootThreadId?: string | null | undefined;
  readonly host: CtPluginHostSdk;
  readonly uiKit: CtPluginUiKit;
}

export interface PluginThreadBannerProps {
  readonly pluginId: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly host: CtPluginHostSdk;
  readonly uiKit: CtPluginUiKit;
}

export interface PluginSettingsSectionProps {
  readonly pluginId: string;
  readonly plugin: PluginRecordView;
  readonly host: CtPluginHostSdk;
  readonly uiKit: CtPluginUiKit;
}

export interface PluginCommandDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly icon?: string | undefined;
  readonly searchTerms?: ReadonlyArray<string> | undefined;
  readonly shortcut?: string | undefined;
  readonly run: () => void | Promise<void>;
}

export interface CtPluginRegistration {
  readonly mainView?:
    | {
        readonly Component: ComponentType<PluginMainViewProps>;
        readonly keepAlive?: boolean | undefined;
      }
    | undefined;
  readonly threadPanel?:
    | {
        readonly Card?: ComponentType<PluginThreadSlotProps> | undefined;
        readonly PopoverRow?: ComponentType<PluginThreadSlotProps> | undefined;
      }
    | undefined;
  readonly threadBanner?: ComponentType<PluginThreadBannerProps> | undefined;
  readonly settingsSection?: ComponentType<PluginSettingsSectionProps> | undefined;
  readonly commands?: ReadonlyArray<PluginCommandDefinition> | undefined;
}

export interface CtPluginContext {
  readonly pluginId: string;
  readonly manifest: CtPluginManifest;
  readonly host: CtPluginHostSdk;
  readonly uiKit: CtPluginUiKit;
}

export interface CtPluginModule {
  activate(
    ctx: CtPluginContext,
  ): CtPluginRegistration | void | Promise<CtPluginRegistration | void>;
  deactivate?(): void | Promise<void>;
}

export interface CtPluginRuntimeGlobal {
  readonly apiVersion: 1;
  readonly React: typeof React;
  readonly ReactDOM: typeof ReactDOM;
  readonly jsxRuntime: typeof jsxRuntime;
  readonly lucide: typeof LucideIcons;
  readonly uiKit: CtPluginUiKit;
}

declare global {
  interface Window {
    __CT_PLUGIN_RUNTIME__?: CtPluginRuntimeGlobal;
  }
}
