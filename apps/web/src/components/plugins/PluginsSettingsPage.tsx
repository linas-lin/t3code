import { useNavigate } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  DownloadIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  GitBranchIcon,
  PuzzleIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { PluginErrorBoundary } from "./PluginErrorBoundary";
import { PluginIcon } from "./pluginRuntime";
import { usePluginStore, type PluginRuntimeEntry } from "./pluginStore";
import type { CtPluginPermission, PluginRecordView } from "./pluginTypes";
import { PLUGIN_UI_KIT } from "./pluginUiKit";

function permissionLabel(permission: CtPluginPermission): string {
  switch (permission) {
    case "threads":
      return "threads";
    case "workspace":
      return "workspace";
    case "backend":
      return "backend";
    case "network":
      return "network";
    case "mcp":
      return "mcp";
    case "host-callback":
      return "host-callback";
  }
}

function backendBadgeVariant(
  status: PluginRecordView["backend"]["status"],
): "success" | "warning" | "error" | "secondary" {
  switch (status) {
    case "running":
      return "success";
    case "starting":
      return "warning";
    case "error":
      return "error";
    case "stopped":
    case "none":
      return "secondary";
  }
}

function PluginRowCard({
  plugin,
  runtime,
  busyAction,
  onToggleEnabled,
  onReload,
  onUpdate,
  onOpenMainView,
  onRequestUninstall,
}: {
  readonly plugin: PluginRecordView;
  readonly runtime: PluginRuntimeEntry | undefined;
  readonly busyAction: string | null;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onReload: () => void;
  readonly onUpdate: (runBuild: boolean) => void;
  readonly onOpenMainView: () => void;
  readonly onRequestUninstall: () => void;
}) {
  const gt = useGT();
  const [updateRunBuild, setUpdateRunBuild] = useState(true);
  const manifest = plugin.manifest;
  const displayName = manifest?.name ?? plugin.id;
  const permissions = manifest?.permissions ?? [];
  const hasMainView = Boolean(runtime?.registration?.mainView);
  const errors = Array.from(
    new Set(
      [plugin.manifestError, plugin.backend.error, runtime?.error].filter(
        (entry): entry is string => Boolean(entry && entry.trim()),
      ),
    ),
  );
  const isBusy = busyAction !== null;

  return (
    <div data-plugin-card={plugin.id} className="space-y-3 rounded-xl px-3 py-3.5 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-foreground">
            <PluginIcon name={manifest?.contributes?.sidebar?.icon} className="size-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="text-sm font-medium text-foreground">{displayName}</h3>
              {manifest?.version ? (
                <Badge variant="outline" size="sm">
                  <span className="font-mono">v{manifest.version}</span>
                </Badge>
              ) : null}
              <Badge variant="secondary" size="sm">
                <span className="font-mono">{plugin.id}</span>
              </Badge>
              <Badge variant={plugin.source.kind === "git" ? "info" : "outline"} size="sm">
                {plugin.source.kind === "git" ? gt("Git") : gt("Dev Link")}
              </Badge>
              {plugin.enabled ? (
                runtime?.status === "loaded" ? (
                  <Badge variant="success" size="sm">
                    {gt("Loaded")}
                  </Badge>
                ) : runtime?.status === "loading" ? (
                  <Badge variant="warning" size="sm">
                    {gt("Loading")}
                  </Badge>
                ) : runtime?.status === "error" || plugin.manifestError ? (
                  <Badge variant="error" size="sm">
                    {gt("Load error")}
                  </Badge>
                ) : (
                  <Badge variant="secondary" size="sm">
                    {gt("Enabled")}
                  </Badge>
                )
              ) : (
                <Badge variant="secondary" size="sm">
                  {gt("Disabled")}
                </Badge>
              )}
              {plugin.backend.configured ? (
                <Badge variant={backendBadgeVariant(plugin.backend.status)} size="sm">
                  {gt("Backend: {status}", { status: plugin.backend.status })}
                </Badge>
              ) : null}
              {manifest?.ui?.entry && !plugin.uiReady ? (
                <Badge variant="warning" size="sm">
                  {gt("UI not built")}
                </Badge>
              ) : null}
            </div>
            {manifest?.description ? (
              <p className="text-xs leading-normal text-muted-foreground">{manifest.description}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-3xs text-muted-foreground">
              {plugin.source.kind === "git" ? (
                <>
                  <span className="inline-flex items-center gap-1 break-all">
                    <FolderGit2Icon className="size-3 shrink-0" aria-hidden />
                    {plugin.source.url}
                  </span>
                  {plugin.source.ref ? (
                    <span className="inline-flex items-center gap-1">
                      <GitBranchIcon className="size-3 shrink-0" aria-hidden />
                      {plugin.source.ref}
                    </span>
                  ) : null}
                  {plugin.source.commit ? <span>{plugin.source.commit.slice(0, 8)}</span> : null}
                </>
              ) : (
                <span className="inline-flex items-center gap-1 break-all">
                  <FolderOpenIcon className="size-3 shrink-0" aria-hidden />
                  {plugin.source.path}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={plugin.enabled}
            disabled={isBusy}
            onCheckedChange={(checked) => onToggleEnabled(Boolean(checked))}
            aria-label={gt("Enable {name}", { name: displayName })}
          />
        </div>
      </div>

      {permissions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-11">
          <span className="inline-flex items-center gap-1 text-3xs font-medium text-muted-foreground">
            <ShieldAlertIcon className="size-3" aria-hidden />
            <T>Permissions:</T>
          </span>
          {permissions.map((permission) => (
            <Badge key={permission} variant="outline" size="sm">
              <span className="font-mono">{permissionLabel(permission)}</span>
            </Badge>
          ))}
        </div>
      ) : null}

      {errors.length > 0 ? (
        <div className="pl-11">
          <Alert variant="error">
            <AlertTriangleIcon className="size-4" aria-hidden />
            <AlertTitle>
              <T>Plugin error</T>
            </AlertTitle>
            <AlertDescription>
              <div className="space-y-1 font-mono text-xs break-words">
                {errors.map((entry) => (
                  <div key={entry}>{entry}</div>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 pl-11">
        <div className="flex flex-wrap items-center gap-1.5">
          {plugin.enabled && hasMainView ? (
            <Button size="xs" variant="outline" disabled={isBusy} onClick={onOpenMainView}>
              <ArrowUpRightIcon className="size-3" aria-hidden />
              <span>{gt("Open")}</span>
            </Button>
          ) : null}
          <Button size="xs" variant="outline" disabled={isBusy} onClick={onReload}>
            <RefreshCwIcon
              className={cn("size-3", busyAction === "reload" && "animate-spin")}
              aria-hidden
            />
            <span>{busyAction === "reload" ? gt("Reloading...") : gt("Reload")}</span>
          </Button>
          {plugin.source.kind === "git" ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={isBusy}
                onClick={() => onUpdate(updateRunBuild)}
              >
                <DownloadIcon className="size-3" aria-hidden />
                <span>{busyAction === "update" ? gt("Updating...") : gt("Pull update")}</span>
              </Button>
              {manifest?.build?.command?.length ? (
                <label className="ml-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={updateRunBuild}
                    onCheckedChange={(checked) => setUpdateRunBuild(Boolean(checked))}
                  />
                  <span>{gt("Rebuild")}</span>
                </label>
              ) : null}
            </>
          ) : null}
        </div>
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={isBusy}
          onClick={onRequestUninstall}
        >
          <Trash2Icon className="size-3" aria-hidden />
          <span>{gt("Uninstall")}</span>
        </Button>
      </div>
    </div>
  );
}

export function PluginsSettingsPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const plugins = usePluginStore((state) => state.plugins);
  const initialized = usePluginStore((state) => state.initialized);
  const loadingList = usePluginStore((state) => state.loadingList);
  const listError = usePluginStore((state) => state.listError);
  const runtimeById = usePluginStore((state) => state.runtimeById);
  const refreshPlugins = usePluginStore((state) => state.refreshPlugins);
  const installPlugin = usePluginStore((state) => state.installPlugin);
  const enablePlugin = usePluginStore((state) => state.enablePlugin);
  const reloadPlugin = usePluginStore((state) => state.reloadPlugin);
  const updatePlugin = usePluginStore((state) => state.updatePlugin);
  const uninstallPlugin = usePluginStore((state) => state.uninstallPlugin);

  const [gitUrl, setGitUrl] = useState("");
  const [gitRef, setGitRef] = useState("");
  const [gitRunBuild, setGitRunBuild] = useState(false);
  const [gitInstalling, setGitInstalling] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  const [localPath, setLocalPath] = useState("");
  const [localRunBuild, setLocalRunBuild] = useState(false);
  const [localInstalling, setLocalInstalling] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const [busyById, setBusyById] = useState<Record<string, string | null>>({});
  const [uninstallTarget, setUninstallTarget] = useState<PluginRecordView | null>(null);
  const [uninstallRemoveData, setUninstallRemoveData] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes plugin list when opening the Plugins settings page
  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  const setPluginBusy = (pluginId: string, action: string | null) => {
    setBusyById((prev) => ({ ...prev, [pluginId]: action }));
  };

  const handleInstallGit = async () => {
    const trimmedUrl = gitUrl.trim();
    if (!trimmedUrl) {
      setGitError(gt("Enter a Git repository URL."));
      return;
    }
    setGitInstalling(true);
    setGitError(null);
    try {
      const trimmedRef = gitRef.trim();
      const installed = await installPlugin({
        source: "git",
        url: trimmedUrl,
        ...(trimmedRef ? { ref: trimmedRef } : {}),
        runBuild: gitRunBuild,
      });
      setGitUrl("");
      setGitRef("");
      toastManager.add({
        type: "success",
        title: gt("Installed plugin {name}", { name: installed.manifest?.name ?? installed.id }),
      });
    } catch (error) {
      setGitError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitInstalling(false);
    }
  };

  const handleLinkLocal = async () => {
    const trimmedPath = localPath.trim();
    if (!trimmedPath) {
      setLocalError(gt("Enter the absolute path to a plugin directory."));
      return;
    }
    setLocalInstalling(true);
    setLocalError(null);
    try {
      const linked = await installPlugin({
        source: "local",
        path: trimmedPath,
        runBuild: localRunBuild,
      });
      setLocalPath("");
      toastManager.add({
        type: "success",
        title: gt("Linked local plugin {name}", { name: linked.manifest?.name ?? linked.id }),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalInstalling(false);
    }
  };

  const handleToggleEnabled = async (plugin: PluginRecordView, enabled: boolean) => {
    setPluginBusy(plugin.id, "enable");
    try {
      await enablePlugin(plugin.id, enabled);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Failed to update plugin state"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPluginBusy(plugin.id, null);
    }
  };

  const handleReload = async (plugin: PluginRecordView) => {
    setPluginBusy(plugin.id, "reload");
    try {
      await reloadPlugin(plugin.id);
      toastManager.add({
        type: "success",
        title: gt("Reloaded {name}", { name: plugin.manifest?.name ?? plugin.id }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Failed to reload {name}", { name: plugin.manifest?.name ?? plugin.id }),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPluginBusy(plugin.id, null);
    }
  };

  const handleUpdate = async (plugin: PluginRecordView, runBuild: boolean) => {
    setPluginBusy(plugin.id, "update");
    try {
      const result = await updatePlugin(plugin.id, { runBuild });
      toastManager.add({
        type: "success",
        title: result.updated
          ? gt("Updated {name}", { name: result.plugin.manifest?.name ?? plugin.id })
          : gt("{name} is already up to date", {
              name: result.plugin.manifest?.name ?? plugin.id,
            }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Failed to update {name}", { name: plugin.manifest?.name ?? plugin.id }),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPluginBusy(plugin.id, null);
    }
  };

  const handleConfirmUninstall = async () => {
    if (!uninstallTarget) return;
    const target = uninstallTarget;
    const removeData = uninstallRemoveData;
    setUninstallTarget(null);
    setUninstallRemoveData(false);
    setPluginBusy(target.id, "uninstall");
    try {
      await uninstallPlugin(target.id, { removeData });
      toastManager.add({
        type: "success",
        title: gt("Uninstalled {name}", { name: target.manifest?.name ?? target.id }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: gt("Failed to uninstall {name}", { name: target.manifest?.name ?? target.id }),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPluginBusy(target.id, null);
    }
  };

  const pluginSettingsSections = plugins.flatMap((plugin) => {
    if (!plugin.enabled) return [];
    const runtime = runtimeById[plugin.id];
    const Section = runtime?.registration?.settingsSection;
    if (runtime?.status !== "loaded" || !Section || !runtime.host) return [];
    return [{ plugin, runtime, Section, host: runtime.host }];
  });

  return (
    <SettingsPageContainer>
      {listError ? (
        <Alert variant="error">
          <AlertTriangleIcon className="size-4" aria-hidden />
          <AlertTitle>
            <T>Unable to load plugins</T>
          </AlertTitle>
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsSection
        id="plugins-install"
        title={gt("Install plugin")}
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            disabled={loadingList}
            onClick={() => void refreshPlugins()}
          >
            <RefreshCwIcon className={cn("size-3.5", loadingList && "animate-spin")} aria-hidden />
            <span>{gt("Refresh")}</span>
          </Button>
        }
      >
        <SettingsRow
          id="plugins-install-git"
          title={gt("Install from Git repository")}
          description={<T>Clone a plugin repository containing ct-plugin.json.</T>}
          status={
            gitError ? (
              <span className="text-destructive">{gitError}</span>
            ) : (
              <span>
                <T>
                  Plugins run with local permissions declared in ct-plugin.json. Build scripts only
                  run when checked below.
                </T>
              </span>
            )
          }
        >
          <div className="mt-2.5 flex flex-col gap-2.5 pb-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={gitUrl}
                onChange={(event) => {
                  setGitUrl(event.target.value);
                  setGitError(null);
                }}
                placeholder="https://github.com/org/my-plugin.git"
                aria-label={gt("Plugin Git repository URL")}
                className="flex-1"
              />
              <Input
                value={gitRef}
                onChange={(event) => setGitRef(event.target.value)}
                placeholder={gt("Branch or tag (optional)")}
                aria-label={gt("Git ref (optional)")}
                className="sm:w-44"
              />
              <Button
                size="sm"
                disabled={gitInstalling || !gitUrl.trim()}
                onClick={() => void handleInstallGit()}
                className="shrink-0"
              >
                {gitInstalling ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <DownloadIcon className="size-3.5" aria-hidden />
                )}
                <span>{gitInstalling ? gt("Installing...") : gt("Install")}</span>
              </Button>
            </div>
            <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={gitRunBuild}
                onCheckedChange={(checked) => setGitRunBuild(Boolean(checked))}
              />
              <span>
                <T>Run plugin build command after cloning if UI bundle is missing</T>
              </span>
            </label>
          </div>
        </SettingsRow>

        <SettingsRow
          id="plugins-install-local"
          title={gt("Link local directory (Dev Link)")}
          description={<T>Mount a local plugin folder for development without copying files.</T>}
          status={
            localError ? (
              <span className="text-destructive">{localError}</span>
            ) : (
              <span>
                <T>
                  Uninstalling a linked folder only unregisters it and never deletes source files.
                </T>
              </span>
            )
          }
        >
          <div className="mt-2.5 flex flex-col gap-2.5 pb-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={localPath}
                onChange={(event) => {
                  setLocalPath(event.target.value);
                  setLocalError(null);
                }}
                placeholder="/path/to/plugin-directory"
                aria-label={gt("Local plugin directory path")}
                className="flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={localInstalling || !localPath.trim()}
                onClick={() => void handleLinkLocal()}
                className="shrink-0"
              >
                {localInstalling ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <FolderOpenIcon className="size-3.5" aria-hidden />
                )}
                <span>{localInstalling ? gt("Linking...") : gt("Link folder")}</span>
              </Button>
            </div>
            <label className="inline-flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={localRunBuild}
                onCheckedChange={(checked) => setLocalRunBuild(Boolean(checked))}
              />
              <span>
                <T>Run plugin build command if UI bundle is missing</T>
              </span>
            </label>
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection id="plugins-installed" title={gt("Installed plugins")}>
        {!initialized && loadingList ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Spinner className="size-4" />
            <span>
              <T>Loading installed plugins...</T>
            </span>
          </div>
        ) : plugins.length === 0 ? (
          <div className="py-4">
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PuzzleIcon />
                </EmptyMedia>
                <EmptyTitle>
                  <T>No plugins installed</T>
                </EmptyTitle>
                <EmptyDescription>
                  <T>Install a plugin from a Git URL or link a local plugin directory above.</T>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {plugins.map((plugin) => (
              <PluginRowCard
                key={plugin.id}
                plugin={plugin}
                runtime={runtimeById[plugin.id]}
                busyAction={busyById[plugin.id] ?? null}
                onToggleEnabled={(enabled) => void handleToggleEnabled(plugin, enabled)}
                onReload={() => void handleReload(plugin)}
                onUpdate={(runBuild) => void handleUpdate(plugin, runBuild)}
                onOpenMainView={() =>
                  void navigate({
                    to: "/plugins/$pluginId",
                    params: { pluginId: plugin.id },
                  })
                }
                onRequestUninstall={() => {
                  setUninstallRemoveData(false);
                  setUninstallTarget(plugin);
                }}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      {pluginSettingsSections.map(({ plugin, runtime, Section, host }) => (
        <SettingsSection
          key={plugin.id}
          id={`plugin-settings-${plugin.id}`}
          title={plugin.manifest?.name ?? plugin.id}
        >
          <div className="p-3 sm:p-4">
            <PluginErrorBoundary
              pluginId={plugin.id}
              pluginName={plugin.manifest?.name ?? plugin.id}
              slot="settingsSection"
              resetKey={runtime.loadedNonce ?? plugin.reloadNonce}
            >
              <Section pluginId={plugin.id} plugin={plugin} host={host} uiKit={PLUGIN_UI_KIT} />
            </PluginErrorBoundary>
          </div>
        </SettingsSection>
      ))}

      <AlertDialog
        open={uninstallTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Uninstall <Var>{uninstallTarget?.manifest?.name ?? uninstallTarget?.id ?? ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {uninstallTarget?.source.kind === "local" ? (
                <T>
                  This unregisters the linked plugin and stops its backend process. Your local
                  source folder will not be deleted.
                </T>
              ) : (
                <T>This stops the plugin backend process and deletes the installed plugin files.</T>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6 py-2">
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={uninstallRemoveData}
                onCheckedChange={(checked) => setUninstallRemoveData(Boolean(checked))}
              />
              <span>
                <T>Also remove isolated plugin data directory</T>
              </span>
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void handleConfirmUninstall()}>
              <T>Uninstall</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
