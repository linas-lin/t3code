import { compileResolvedKeybindingRule } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveShortcutCommand } from "~/keybindings";
import {
  buildEnabledPluginToggleCommands,
  commandForPluginToggle,
  mergeKeybindingsWithPlugins,
  pluginIdFromToggleCommand,
  shortcutLabelForPluginToggle,
} from "./pluginKeybindings";
import type { PluginRecordView } from "./pluginTypes";

function makePlugin(overrides: Partial<PluginRecordView> = {}): PluginRecordView {
  return {
    id: "ct-studio",
    source: { kind: "local", path: "/tmp/ct-studio" },
    rootDir: "/tmp/ct-studio",
    enabled: true,
    installedAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    reloadNonce: 0,
    manifest: {
      id: "ct-studio",
      name: "CT Studio",
      version: "1.0.0",
      apiVersion: 1,
      permissions: [],
      contributes: {
        sidebar: {
          label: "CT Studio",
          icon: "layout-grid",
          shortcut: "Mod+Shift+Y",
        },
        slots: ["mainView"],
      },
    },
    manifestError: null,
    uiReady: true,
    backend: {
      configured: false,
      activation: null,
      status: "none",
      error: null,
      startedAt: null,
    },
    ...overrides,
  };
}

describe("pluginKeybindings", () => {
  it("maps valid plugin ids to plugin.<id>.toggle commands and back", () => {
    expect(commandForPluginToggle("ct-studio")).toBe("plugin.ct-studio.toggle");
    expect(pluginIdFromToggleCommand("plugin.ct-studio.toggle")).toBe("ct-studio");
    expect(commandForPluginToggle("INVALID_ID")).toBeNull();
    expect(pluginIdFromToggleCommand("preview.toggle")).toBeNull();
  });

  it("uses the manifest default shortcut when the user has not customized the plugin command", () => {
    const plugins = [makePlugin()];
    const merged = mergeKeybindingsWithPlugins([], plugins);

    const matched = resolveShortcutCommand(
      { key: "Y", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
      merged,
      { platform: "MacIntel" },
    );
    expect(matched).toBe("plugin.ct-studio.toggle");
    expect(shortcutLabelForPluginToggle([], plugins, "ct-studio", "MacIntel")).toBe("⇧⌘Y");
    expect(buildEnabledPluginToggleCommands(plugins)).toEqual(["plugin.ct-studio.toggle"]);
  });

  it("lets user keybindings override or disable the manifest default shortcut", () => {
    const plugins = [makePlugin()];
    const customRule = compileResolvedKeybindingRule({
      key: "mod+shift+u",
      command: "plugin.ct-studio.toggle",
    })!;

    const mergedCustom = mergeKeybindingsWithPlugins([customRule], plugins);
    expect(
      resolveShortcutCommand(
        { key: "Y", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
        mergedCustom,
        { platform: "MacIntel" },
      ),
    ).toBeNull();
    expect(
      resolveShortcutCommand(
        { key: "U", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
        mergedCustom,
        { platform: "MacIntel" },
      ),
    ).toBe("plugin.ct-studio.toggle");
    expect(shortcutLabelForPluginToggle([customRule], plugins, "ct-studio", "MacIntel")).toBe(
      "⇧⌘U",
    );

    const disabledRule = compileResolvedKeybindingRule({
      key: "mod+shift+y",
      command: "plugin.ct-studio.toggle",
      when: "false",
    })!;
    expect(
      shortcutLabelForPluginToggle([disabledRule], plugins, "ct-studio", "MacIntel"),
    ).toBeNull();
  });

  it("ignores disabled plugins", () => {
    const plugins = [makePlugin({ enabled: false })];
    expect(mergeKeybindingsWithPlugins([], plugins)).toEqual([]);
    expect(buildEnabledPluginToggleCommands(plugins)).toEqual([]);
  });
});
