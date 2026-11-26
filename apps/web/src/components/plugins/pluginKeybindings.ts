import {
  PLUGIN_TOGGLE_COMMAND_PATTERN,
  type KeybindingCommand,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import * as Schema from "effect/Schema";

import { shortcutLabelForCommand } from "~/keybindings";
import type { PluginRecordView } from "./pluginTypes";

const isPluginToggleCommand = Schema.is(PLUGIN_TOGGLE_COMMAND_PATTERN);

export function commandForPluginToggle(pluginId: string): KeybindingCommand | null {
  const candidate = `plugin.${pluginId}.toggle`;
  return isPluginToggleCommand(candidate) ? candidate : null;
}

export function pluginIdFromToggleCommand(command: KeybindingCommand | null): string | null {
  if (!command || !isPluginToggleCommand(command)) return null;
  const raw = String(command);
  if (!raw.startsWith("plugin.") || !raw.endsWith(".toggle")) return null;
  return raw.slice("plugin.".length, -".toggle".length);
}

export function buildEnabledPluginToggleCommands(
  plugins: ReadonlyArray<PluginRecordView>,
): ReadonlyArray<KeybindingCommand> {
  const commands: Array<KeybindingCommand> = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const hasSidebarOrMain = Boolean(
      plugin.manifest?.contributes?.sidebar ||
      plugin.manifest?.contributes?.slots?.includes("mainView"),
    );
    if (!hasSidebarOrMain) continue;
    const command = commandForPluginToggle(plugin.id);
    if (command) commands.push(command);
  }
  return commands;
}

function buildPluginDefaultKeybindings(
  plugins: ReadonlyArray<PluginRecordView>,
): ReadonlyArray<ResolvedKeybindingRule> {
  const rules: Array<ResolvedKeybindingRule> = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const shortcut = plugin.manifest?.contributes?.sidebar?.shortcut?.trim();
    if (!shortcut) continue;
    const command = commandForPluginToggle(plugin.id);
    if (!command) continue;
    const compiled = compileResolvedKeybindingRule({
      key: shortcut.toLowerCase(),
      command,
    });
    if (compiled) {
      rules.push(compiled);
    }
  }
  return rules;
}

/**
 * Merges enabled plugin default shortcuts with resolved server keybindings.
 * User-configured rules for a plugin command (including disabled `when: "false"` rules)
 * completely override the plugin manifest's default shortcut.
 */
export function mergeKeybindingsWithPlugins(
  serverKeybindings: ResolvedKeybindingsConfig,
  plugins: ReadonlyArray<PluginRecordView>,
): ResolvedKeybindingsConfig {
  const configuredCommands = new Set<KeybindingCommand>(
    serverKeybindings.map((binding) => binding.command),
  );
  const defaults = buildPluginDefaultKeybindings(plugins).filter(
    (rule) => !configuredCommands.has(rule.command),
  );
  if (defaults.length === 0) return serverKeybindings;
  return [...defaults, ...serverKeybindings];
}

export function shortcutLabelForPluginToggle(
  serverKeybindings: ResolvedKeybindingsConfig,
  plugins: ReadonlyArray<PluginRecordView>,
  pluginId: string,
  platform = navigator.platform,
): string | null {
  const command = commandForPluginToggle(pluginId);
  if (!command) return null;
  const effective = mergeKeybindingsWithPlugins(serverKeybindings, plugins);
  return shortcutLabelForCommand(effective, command, { platform });
}
