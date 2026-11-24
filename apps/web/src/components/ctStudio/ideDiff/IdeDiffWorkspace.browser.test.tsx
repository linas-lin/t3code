import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../../test/render";
import { useIdeDiffViewedStore } from "./ideDiffPreferences";
import { IdeDiffWorkspace } from "./IdeDiffWorkspace";
import type {
  IdeDiffAnnotationAdapter,
  IdeDiffContentProvider,
  IdeDiffFileEntry,
  IdeDiffInlineAnnotation,
} from "./types";

const SAMPLE_ENTRIES: ReadonlyArray<IdeDiffFileEntry> = [
  {
    fileKey: "src/components/feature/alpha.ts:0",
    path: "src/components/feature/alpha.ts",
    status: "modified",
    additions: 2,
    deletions: 1,
    isTest: false,
  },
  {
    fileKey: "src/components/feature/beta.ts:0",
    path: "src/components/feature/beta.ts",
    status: "added",
    additions: 3,
    deletions: 0,
    isTest: false,
  },
];

const SAMPLE_CONTENTS: Record<string, { oldText: string; newText: string }> = {
  "src/components/feature/alpha.ts": {
    oldText: "export const greeting = 'hello';\nexport const count = 1;\n",
    newText:
      "export const greeting = 'hello world';\nexport const count = 2;\nexport const extra = true;\n",
  },
  "src/components/feature/beta.ts": {
    oldText: "",
    newText: "export function add(a: number, b: number) {\n  return a + b;\n}\n",
  },
};

function Harness({ onSwitchToClassic = vi.fn() }: { readonly onSwitchToClassic?: () => void }) {
  const [layout, setLayout] = useState<"split" | "unified">("split");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [wordWrap, setWordWrap] = useState(false);
  const [comments, setComments] = useState<ReadonlyArray<IdeDiffInlineAnnotation>>([
    {
      id: "comment-1",
      side: "modified",
      startLine: 1,
      endLine: 1,
      rangeLabel: "+1",
      body: "Consider extracting this constant",
      status: "draft",
      canDelete: true,
    },
  ]);

  const contentProvider: IdeDiffContentProvider = {
    cacheScopeKey: "test-scope",
    async loadFileContent(entry) {
      const pair = SAMPLE_CONTENTS[entry.path] ?? { oldText: "", newText: "" };
      return {
        kind: "text",
        oldText: pair.oldText,
        newText: pair.newText,
        language: "typescript",
        oldLabel: "main",
        newLabel: "Working tree",
      };
    },
  };

  const annotationAdapter: IdeDiffAnnotationAdapter = {
    getAnnotations(entry) {
      return entry.path === "src/components/feature/alpha.ts" ? comments : [];
    },
    submitAnnotation(input) {
      setComments((current) => [
        ...current,
        {
          id: `comment-${current.length + 1}`,
          side: input.side,
          startLine: input.startLine,
          endLine: input.endLine,
          rangeLabel: `+${input.endLine}`,
          body: input.text,
          status: "draft",
          canDelete: true,
        },
      ]);
    },
    deleteAnnotation(_entry, id) {
      setComments((current) => current.filter((item) => item.id !== id));
    },
  };

  return (
    <div style={{ width: "1100px", height: "640px", display: "flex" }}>
      <IdeDiffWorkspace
        scopeKey="browser-test-scope"
        scopeTitle="Changes"
        entries={SAMPLE_ENTRIES}
        contentProvider={contentProvider}
        annotationAdapter={annotationAdapter}
        resolvedTheme="dark"
        diffLayout={layout}
        onDiffLayoutChange={setLayout}
        ignoreWhitespace={ignoreWhitespace}
        onIgnoreWhitespaceChange={setIgnoreWhitespace}
        wordWrap={wordWrap}
        onWordWrapChange={setWordWrap}
        onSwitchToClassic={onSwitchToClassic}
      />
    </div>
  );
}

it("renders compact file tree, switches files, toggles viewed progress, and supports fullscreen overlay", async () => {
  useIdeDiffViewedStore.getState().resetAllForTest();
  const onSwitchToClassic = vi.fn();

  await using screen = await render(<Harness onSwitchToClassic={onSwitchToClassic} />, {
    router: false, // standalone workspace component without route hooks
  });

  // Compact middle directory node appears in tree.
  await expect.element(screen.getByText("src/components/feature")).toBeVisible();
  await expect.element(screen.getByText("alpha.ts")).toBeVisible();
  await expect.element(screen.getByText("0/2 viewed")).toBeVisible();

  // Persisted inline annotation renders via Monaco ViewZone portal.
  await expect.element(screen.getByText("Consider extracting this constant")).toBeVisible();

  // Toggle Viewed updates review counter.
  await userEvent.click(screen.getByRole("button", { name: "Viewed" }));
  await expect.element(screen.getByText("1/2 viewed")).toBeVisible();

  // Switch file via file tree.
  await userEvent.click(screen.getByText("beta.ts"));
  await expect.element(screen.getByText("src/components/feature/beta.ts")).toBeVisible();

  // Fullscreen overlay opens and closes with Close button.
  await userEvent.click(screen.getByRole("button", { name: "Fullscreen review" }));
  await expect.element(screen.getByRole("dialog", { name: "Changes" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Exit fullscreen review" }).first());
  await expect.element(screen.getByRole("dialog", { name: "Changes" })).not.toBeInTheDocument();

  // Switching back to Classic invokes host callback.
  await userEvent.click(screen.getByRole("button", { name: "Switch to classic diff view" }));
  expect(onSwitchToClassic).toHaveBeenCalledTimes(1);
});
