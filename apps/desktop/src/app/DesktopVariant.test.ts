import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { getDesktopScheme } from "../electron/ElectronProtocol.ts";
import { resolveDesktopAppBranding } from "./DesktopEnvironment.ts";
import { resolveDesktopBaseDir } from "./DesktopStatePaths.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";
import {
  normalizeDesktopVariant,
  resolveDefaultBaseDirName,
  resolveLinuxDesktopEntryNameForVariant,
  resolveProductionAppUserModelId,
  resolveProductionDesktopScheme,
  resolveProductionUserDataDirName,
} from "./DesktopVariant.ts";

describe("DesktopVariant", () => {
  it("normalizes unknown values to standard and keeps ct isolated", () => {
    assert.equal(normalizeDesktopVariant(undefined), "standard");
    assert.equal(normalizeDesktopVariant("standard"), "standard");
    assert.equal(normalizeDesktopVariant("ct"), "ct");
    assert.equal(normalizeDesktopVariant(" ct "), "ct");

    assert.equal(resolveDefaultBaseDirName("standard"), ".t3");
    assert.equal(resolveDefaultBaseDirName("ct"), ".t3-ct");
    assert.equal(resolveProductionUserDataDirName("standard"), "t3code-v2");
    assert.equal(resolveProductionUserDataDirName("ct"), "t3code-ct");
    assert.equal(resolveProductionDesktopScheme("standard"), "t3code");
    assert.equal(resolveProductionDesktopScheme("ct"), "t3code-dev");
    assert.equal(resolveProductionAppUserModelId("standard"), "com.t3tools.t3code");
    assert.equal(resolveProductionAppUserModelId("ct"), "com.ct.t3code");
    assert.equal(resolveLinuxDesktopEntryNameForVariant(false, "ct"), "com.ct.T3Code.desktop");
    assert.equal(
      resolveLinuxDesktopEntryNameForVariant(true, "ct"),
      "com.t3tools.T3Code.Development.desktop",
    );
  });

  it("resolves ct baseDir, scheme, and branding without overriding explicit T3CODE_HOME", () => {
    assert.equal(
      resolveDesktopBaseDir({
        homeDirectory: "/Users/alice",
        joinPath: (...segments) => segments.join("/"),
        t3Home: Option.none(),
        variant: "ct",
      }),
      "/Users/alice/.t3-ct",
    );
    assert.equal(
      resolveDesktopBaseDir({
        homeDirectory: "/Users/alice",
        joinPath: (...segments) => segments.join("/"),
        t3Home: Option.some("/custom/home"),
        variant: "ct",
      }),
      "/custom/home",
    );
    assert.equal(getDesktopScheme(false, "ct"), "t3code-dev");
    assert.equal(getDesktopScheme(true, "ct"), "t3code-dev");
    assert.deepStrictEqual(
      resolveDesktopAppBranding({ isDevelopment: false, appVersion: "0.1.11", variant: "ct" }),
      {
        baseName: "T3 Code",
        stageLabel: "CT",
        displayName: "T3 Code (CT)",
      },
    );
  });

  it.effect("isolates ct userData profile without migrating official Windows Local State", () =>
    Effect.gen(function* () {
      const userDataPath = yield* resolveUserDataPath({
        appDataDirectory: "/Users/alice/Library/Application Support",
        isDevelopment: false,
        platform: "darwin",
        variant: "ct",
      });
      assert.equal(userDataPath, "/Users/alice/Library/Application Support/t3code-ct");

      const winUserDataPath = yield* resolveUserDataPath({
        appDataDirectory: "C:/Users/alice/AppData/Roaming",
        isDevelopment: false,
        platform: "win32",
        variant: "ct",
      });
      assert.equal(winUserDataPath, "C:/Users/alice/AppData/Roaming/t3code-ct");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodePath.layerPosix))),
  );
});
