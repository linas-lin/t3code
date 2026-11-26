import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import {
  isPathWithinRoot,
  isValidPluginId,
  parsePluginManifest,
  parsePluginManifestJson,
  resolveSafePluginSubpath,
  validatePluginRelativePath,
} from "./pluginContract.ts";
import { validateAndNormalizeGitUrl, validateGitRef } from "./pluginGitInstaller.ts";

describe("pluginContract", () => {
  it("parses a complete valid ct-plugin.json manifest", () => {
    const result = parsePluginManifest({
      id: "ct-studio",
      name: "CT Studio",
      version: "1.0.0",
      description: "Team workbench plugin",
      apiVersion: 1,
      ui: {
        entry: "app/.build/plugin/ui.mjs",
        css: "app/.build/plugin/ui.css",
      },
      backend: {
        activation: "startup",
        command: ["node", "app/bin/ct-studio.ts", "plugin-server"],
        healthcheck: "/api/health",
        cwd: "app",
      },
      build: {
        command: ["npm", "--prefix", "app", "run", "build:plugin"],
      },
      permissions: ["threads", "workspace", "backend", "threads"],
      contributes: {
        sidebar: {
          label: "CT Studio",
          icon: "layout-grid",
          shortcut: "Mod+Shift+J",
        },
        slots: ["mainView", "threadPanel", "settingsSection", "commands", "mainView"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toEqual({
      id: "ct-studio",
      name: "CT Studio",
      version: "1.0.0",
      description: "Team workbench plugin",
      apiVersion: 1,
      ui: {
        entry: "app/.build/plugin/ui.mjs",
        css: "app/.build/plugin/ui.css",
      },
      backend: {
        activation: "startup",
        command: ["node", "app/bin/ct-studio.ts", "plugin-server"],
        healthcheck: "/api/health",
        cwd: "app",
      },
      build: {
        command: ["npm", "--prefix", "app", "run", "build:plugin"],
      },
      permissions: ["threads", "workspace", "backend"],
      contributes: {
        sidebar: {
          label: "CT Studio",
          icon: "layout-grid",
          shortcut: "Mod+Shift+J",
        },
        slots: ["mainView", "threadPanel", "settingsSection", "commands"],
      },
    });
  });

  it("applies defaults for backend.activation and backend.healthcheck", () => {
    const result = parsePluginManifest({
      id: "demo-1",
      name: "Demo",
      version: "0.1.0",
      apiVersion: 1,
      backend: {
        command: ["node", "server.mjs"],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.backend).toEqual({
      activation: "lazy",
      command: ["node", "server.mjs"],
      healthcheck: "/api/health",
    });
  });

  it("rejects unsupported apiVersion, invalid id, and invalid permissions/slots", () => {
    const badVersion = parsePluginManifest({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: 2,
    });
    expect(badVersion.ok).toBe(false);
    if (!badVersion.ok) {
      expect(badVersion.error).toContain("apiVersion");
    }

    expect(isValidPluginId("a")).toBe(true);
    expect(isValidPluginId("demo-plugin-1")).toBe(true);
    expect(isValidPluginId("-bad")).toBe(false);
    expect(isValidPluginId("BadUpper")).toBe(false);
    expect(isValidPluginId("a".repeat(41))).toBe(false);

    const badPerm = parsePluginManifest({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: 1,
      permissions: ["root-shell"],
    });
    expect(badPerm.ok).toBe(false);

    const badSlot = parsePluginManifest({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: 1,
      contributes: { slots: ["unknownSlot"] },
    });
    expect(badSlot.ok).toBe(false);

    const badJson = parsePluginManifestJson("{not-json");
    expect(badJson.ok).toBe(false);
  });

  it("rejects path traversal in manifest paths and relative path validation", () => {
    expect(validatePluginRelativePath("../secret.js", "ui.entry").ok).toBe(false);
    expect(validatePluginRelativePath("a/../../secret.js", "ui.entry").ok).toBe(false);
    expect(validatePluginRelativePath("/etc/passwd", "ui.entry").ok).toBe(false);
    expect(validatePluginRelativePath("C:/Windows/win.ini", "ui.entry").ok).toBe(false);
    expect(validatePluginRelativePath("dir\\file.js", "ui.entry").ok).toBe(false);
    expect(validatePluginRelativePath("ui.mjs\0.png", "ui.entry").ok).toBe(false);
    expect(validatePluginRelativePath("./dist/ui.mjs", "ui.entry")).toEqual({
      ok: true,
      normalized: "dist/ui.mjs",
    });

    const manifestWithTraversal = parsePluginManifest({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      apiVersion: 1,
      ui: { entry: "../outside.mjs" },
    });
    expect(manifestWithTraversal.ok).toBe(false);

    expect(isPathWithinRoot("/tmp/plugin", "/tmp/plugin/ui.mjs")).toBe(true);
    expect(isPathWithinRoot("/tmp/plugin", "/tmp/plugin-other/ui.mjs")).toBe(false);
  });

  it.live("blocks symlinks escaping the plugin root directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathApi = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-symlink-test-" });
        const pluginRoot = pathApi.join(base, "plugin");
        const outsideFile = pathApi.join(base, "secret.txt");
        yield* fs.makeDirectory(pluginRoot, { recursive: true });
        yield* fs.writeFileString(outsideFile, "top-secret");
        yield* fs.writeFileString(pathApi.join(pluginRoot, "inside.txt"), "ok");
        yield* fs.symlink(outsideFile, pathApi.join(pluginRoot, "escape.txt"));

        const inside = yield* resolveSafePluginSubpath(
          pluginRoot,
          "inside.txt",
          "asset",
          fs,
          pathApi,
          { requireExisting: true },
        );
        expect(inside.normalized).toBe("inside.txt");

        const escaped = yield* resolveSafePluginSubpath(
          pluginRoot,
          "escape.txt",
          "asset",
          fs,
          pathApi,
          { requireExisting: true },
        ).pipe(Effect.result);
        expect(escaped._tag).toBe("Failure");
        if (escaped._tag === "Failure") {
          expect(escaped.failure.code).toBe("forbidden");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("validates and normalizes Git URLs and refs safely", () => {
    expect(validateAndNormalizeGitUrl("https://github.com/org/plugin.git").ok).toBe(true);
    expect(validateAndNormalizeGitUrl("ssh://git@github.com/org/plugin.git").ok).toBe(true);
    expect(validateAndNormalizeGitUrl("git@github.com:org/plugin.git")).toEqual({
      ok: true,
      url: "git@github.com:org/plugin.git",
    });
    expect(validateAndNormalizeGitUrl("file:///tmp/repo.git").ok).toBe(true);

    expect(validateAndNormalizeGitUrl("--upload-pack=evil").ok).toBe(false);
    expect(validateAndNormalizeGitUrl("ext::sh -c evil").ok).toBe(false);
    expect(validateAndNormalizeGitUrl("https://github.com/org/repo\nmalicious").ok).toBe(false);
    expect(validateAndNormalizeGitUrl("/local/path").ok).toBe(false);

    expect(validateGitRef("main")).toEqual({ ok: true, ref: "main" });
    expect(validateGitRef("release/v1.0.0").ok).toBe(true);
    expect(validateGitRef("--branch=evil").ok).toBe(false);
    expect(validateGitRef("main..dev").ok).toBe(false);
  });
});
