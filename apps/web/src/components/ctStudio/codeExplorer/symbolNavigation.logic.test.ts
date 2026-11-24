import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDefinitionSearchRegex,
  extractImportHints,
  extractSymbolAtPosition,
  findLocalDefinitionsInFile,
  isLikelyDeclarationLine,
  rankAndDedupeLocations,
  scoreDefinitionCandidate,
  shouldAutoJumpDefinition,
} from "./symbolNavigation.logic";
import type { ExplorerFileTarget, SymbolLocation } from "./types";

const ENV = "env-1" as EnvironmentId;

const CURRENT_FILE: ExplorerFileTarget = {
  repoId: `${ENV}::/work/blueapron-project`,
  repoName: "blueapron-project",
  cwd: "/work/blueapron-project",
  environmentId: ENV,
  relativePath: "src/main/java/com/ba/autoship/CartController.java",
  lineNumber: 50,
};

describe("symbolNavigation.logic", () => {
  it("extracts cursor identifier and optional left qualifier", () => {
    const line = "    cartService.enqueueMarkFulfillableEvent(autoShipCart);";
    expect(extractSymbolAtPosition(line, 20)).toEqual({
      symbol: "enqueueMarkFulfillableEvent",
      qualifier: "cartService",
    });
    expect(extractSymbolAtPosition(line, 8)).toEqual({
      symbol: "cartService",
    });
  });

  it("extracts Java, TypeScript, and Protobuf import hints", () => {
    const javaSource = [
      "package com.ba.autoship;",
      "import com.ba.autoship.service.AutoShipCartService;",
      "import static com.ba.util.DateHelper.today;",
    ].join("\n");
    expect(extractImportHints(javaSource)).toContain("com/ba/autoship/service/autoshipcartservice");

    const tsSource = `import { useIdeDiff } from "~/components/ctStudio/ideDiff/ideDiffPreferences";`;
    expect(extractImportHints(tsSource)).toContain(
      "components/ctstudio/idediff/idediffpreferences",
    );
  });

  it("distinguishes declarations from method call sites across Java, TS, and Proto", () => {
    expect(
      isLikelyDeclarationLine(
        "  private void enqueueMarkFulfillableEvent(AutoShipCart cart) {",
        "enqueueMarkFulfillableEvent",
      ),
    ).toBe(true);
    expect(
      isLikelyDeclarationLine(
        "    cartService.enqueueMarkFulfillableEvent(autoShipCart);",
        "enqueueMarkFulfillableEvent",
      ),
    ).toBe(false);
    expect(
      isLikelyDeclarationLine("export interface AutoShipCartService {", "AutoShipCartService"),
    ).toBe(true);
    expect(isLikelyDeclarationLine("message MarkFulfillableEvent {", "MarkFulfillableEvent")).toBe(
      true,
    );
  });

  it("builds valid regexes within the 256-char server limit", () => {
    const javaMethod = buildDefinitionSearchRegex("enqueueMarkFulfillableEvent", "java");
    const tsType = buildDefinitionSearchRegex("AutoShipCart", "typescript");
    const protoMsg = buildDefinitionSearchRegex("CartUpdated", "protobuf");
    expect(javaMethod.length).toBeLessThanOrEqual(256);
    expect(new RegExp(javaMethod).test("public void enqueueMarkFulfillableEvent(Cart c) {")).toBe(
      true,
    );
    expect(new RegExp(tsType).test("export interface AutoShipCart {")).toBe(true);
    expect(new RegExp(protoMsg).test("message CartUpdated {")).toBe(true);
  });

  it("ranks imported definitions highest and triggers auto-jump when confidence gap is large", () => {
    const importHints = ["com/ba/autoship/service/autoshipcartservice"];

    const importedScore = scoreDefinitionCandidate({
      candidate: {
        repoId: CURRENT_FILE.repoId,
        relativePath: "src/main/java/com/ba/autoship/service/AutoShipCartService.java",
        lineNumber: 12,
        lineContent: "public class AutoShipCartService {",
      },
      symbol: "AutoShipCartService",
      currentFile: CURRENT_FILE,
      importHints,
    });

    const testDoubleScore = scoreDefinitionCandidate({
      candidate: {
        repoId: CURRENT_FILE.repoId,
        relativePath: "src/test/java/com/ba/autoship/FakeAutoShipCartServiceTest.java",
        lineNumber: 8,
        lineContent: "// AutoShipCartService fake",
      },
      symbol: "AutoShipCartService",
      currentFile: CURRENT_FILE,
      importHints,
    });

    const ranked = rankAndDedupeLocations([
      {
        id: "2",
        repoId: CURRENT_FILE.repoId,
        repoName: CURRENT_FILE.repoName,
        cwd: CURRENT_FILE.cwd,
        environmentId: ENV,
        relativePath: "src/test/java/com/ba/autoship/FakeAutoShipCartServiceTest.java",
        lineNumber: 8,
        column: 1,
        previewLine: "// AutoShipCartService fake",
        kind: "definition",
        score: testDoubleScore,
      },
      {
        id: "1",
        repoId: CURRENT_FILE.repoId,
        repoName: CURRENT_FILE.repoName,
        cwd: CURRENT_FILE.cwd,
        environmentId: ENV,
        relativePath: "src/main/java/com/ba/autoship/service/AutoShipCartService.java",
        lineNumber: 12,
        column: 14,
        previewLine: "public class AutoShipCartService {",
        kind: "definition",
        score: importedScore,
      },
    ] satisfies ReadonlyArray<SymbolLocation>);

    expect(ranked[0]?.relativePath).toContain("AutoShipCartService.java");
    expect(shouldAutoJumpDefinition(ranked)).toBe(true);
  });

  it("finds local method definitions in the current file without matching the cursor line", () => {
    const fileText = [
      "class CartService {",
      "  void run() {",
      "    enqueueEvent();",
      "  }",
      "  private void enqueueEvent() {",
      "  }",
      "}",
    ].join("\n");

    const local = findLocalDefinitionsInFile({
      symbol: "enqueueEvent",
      currentFile: { ...CURRENT_FILE, lineNumber: 3 },
      currentFileText: fileText,
    });
    expect(local).toHaveLength(1);
    expect(local[0]?.lineNumber).toBe(5);
  });
});
