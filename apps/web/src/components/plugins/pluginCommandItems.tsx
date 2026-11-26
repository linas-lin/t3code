import type { ReactElement } from "react";

import { PluginIcon } from "./pluginRuntime";
import { usePluginStore } from "./pluginStore";

export interface PluginCommandPaletteItem {
  readonly kind: "action";
  readonly value: string;
  readonly searchTerms: string[];
  readonly title: string;
  readonly description: string;
  readonly icon: ReactElement;
  readonly run: () => Promise<void>;
}

export function usePluginCommandItems(iconClassName: string): PluginCommandPaletteItem[] {
  const installedPlugins = usePluginStore((state) => state.plugins);
  const pluginRuntimeById = usePluginStore((state) => state.runtimeById);

  const items: PluginCommandPaletteItem[] = [];
  for (const plugin of installedPlugins) {
    if (!plugin.enabled) continue;
    const runtime = pluginRuntimeById[plugin.id];
    const commands = runtime?.status === "loaded" ? runtime.registration?.commands : undefined;
    if (!commands?.length) continue;
    const pluginName = plugin.manifest?.name ?? plugin.id;
    const defaultIconName = plugin.manifest?.contributes?.sidebar?.icon;
    for (const command of commands) {
      items.push({
        kind: "action",
        value: `plugin:${plugin.id}:${command.id}`,
        searchTerms: [plugin.id, pluginName, command.title, ...(command.searchTerms ?? [])],
        title: command.title,
        description: command.description ?? pluginName,
        icon: <PluginIcon name={command.icon ?? defaultIconName} className={iconClassName} />,
        run: async () => {
          await command.run();
        },
      });
    }
  }
  return items;
}
