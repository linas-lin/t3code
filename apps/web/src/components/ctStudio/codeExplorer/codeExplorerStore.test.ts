import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildExplorerFileKey, useCodeExplorerStore } from "./codeExplorerStore";

const ENV = "env-1" as EnvironmentId;

describe("codeExplorerStore", () => {
  it("tracks active file target and navigates back/forward through jump history", () => {
    useCodeExplorerStore.getState().resetForTest();

    const first = {
      repoId: `${ENV}::/work/ba`,
      repoName: "blueapron-project",
      cwd: "/work/ba",
      environmentId: ENV,
      relativePath: "src/A.java",
      lineNumber: 10,
    };
    const second = {
      repoId: `${ENV}::/work/protos`,
      repoName: "protos",
      cwd: "/work/protos",
      environmentId: ENV,
      relativePath: "order/event.proto",
      lineNumber: 42,
    };

    useCodeExplorerStore.getState().openFileTarget(first);
    useCodeExplorerStore.getState().openFileTarget(second);

    const activeAfterSecond = useCodeExplorerStore.getState().activeTarget;
    expect(activeAfterSecond).not.toBeNull();
    expect(buildExplorerFileKey(activeAfterSecond!.repoId, activeAfterSecond!.relativePath)).toBe(
      buildExplorerFileKey(second.repoId, second.relativePath),
    );
    expect(useCodeExplorerStore.getState().history).toHaveLength(2);

    const back = useCodeExplorerStore.getState().navigateBack();
    expect(back?.relativePath).toBe("src/A.java");
    expect(useCodeExplorerStore.getState().activeTarget?.relativePath).toBe("src/A.java");

    const forward = useCodeExplorerStore.getState().navigateForward();
    expect(forward?.relativePath).toBe("order/event.proto");
    expect(useCodeExplorerStore.getState().activeTarget?.relativePath).toBe("order/event.proto");
  });
});
