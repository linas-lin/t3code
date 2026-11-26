import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT: () => (template: string, vars?: Record<string, unknown>) =>
    vars
      ? template.replace(/\{(\w+)\}/g, (_match, key: string) => String(vars[key] ?? ""))
      : template,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <A,>(initial: A) => [initial, () => {}],
}));

import { PluginErrorBoundary, PluginErrorFallback } from "./PluginErrorBoundary";

function findButtons(node: ReactNode): Array<{ label: string; onClick?: () => void }> {
  const results: Array<{ label: string; onClick?: () => void }> = [];
  const extractText = (value: ReactNode): string => {
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map(extractText).join("");
    if (isValidElement<{ children?: ReactNode }>(value)) return extractText(value.props.children);
    return "";
  };
  const visit = (value: ReactNode) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(value)) return;
    if (typeof value.props.onClick === "function") {
      results.push({ label: extractText(value.props.children), onClick: value.props.onClick });
    }
    visit(value.props.children);
  };
  visit(node);
  return results;
}

describe("PluginErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children transparently when no error occurs", () => {
    const html = renderToStaticMarkup(
      <PluginErrorBoundary pluginId="demo-plugin" pluginName="Demo Plugin">
        <div>Healthy Plugin UI</div>
      </PluginErrorBoundary>,
    );
    expect(html).toContain("Healthy Plugin UI");
    expect(html).not.toContain("Reload plugin");
  });

  it("derives error state from thrown errors and resets when resetKey changes", () => {
    const derived = PluginErrorBoundary.getDerivedStateFromError(new Error("Render exploded"));
    expect(derived).toEqual({
      hasError: true,
      errorMessage: "Render exploded",
    });

    const reset = PluginErrorBoundary.getDerivedStateFromProps(
      { pluginId: "demo", resetKey: 2, children: null },
      { hasError: true, errorMessage: "Render exploded", prevResetKey: 1 },
    );
    expect(reset).toEqual({
      hasError: false,
      errorMessage: null,
      prevResetKey: 2,
    });

    const unchanged = PluginErrorBoundary.getDerivedStateFromProps(
      { pluginId: "demo", resetKey: 2, children: null },
      { hasError: true, errorMessage: "Render exploded", prevResetKey: 2 },
    );
    expect(unchanged).toBeNull();
  });

  it("renders Reload plugin and Disable plugin actions in fallback UI and wires callbacks", () => {
    const onReload = vi.fn();
    const onDisable = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const boundary = new PluginErrorBoundary({
      pluginId: "demo-plugin",
      pluginName: "Demo Plugin",
      slot: "mainView",
      onReload,
      onDisable,
      children: createElement("div", null, "Child"),
    });
    boundary.setState = vi.fn();
    boundary.state = {
      hasError: true,
      errorMessage: "Hooks mismatch",
      prevResetKey: undefined,
    };
    boundary.componentDidCatch(new Error("Hooks mismatch"), { componentStack: "\n  at Broken" });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    const renderedFallback = boundary.render();
    expect(isValidElement(renderedFallback)).toBe(true);

    const fullHtml = renderToStaticMarkup(
      createElement(PluginErrorFallback, {
        pluginId: "demo-plugin",
        pluginName: "Demo Plugin",
        slot: "mainView",
        errorMessage: "Hooks mismatch",
        onReload,
        onDisable,
      }),
    );
    expect(fullHtml).toContain("Plugin Demo Plugin crashed");
    expect(fullHtml).toContain("Hooks mismatch");
    expect(fullHtml).toContain("Reload plugin");
    expect(fullHtml).toContain("Disable plugin");

    const compactHtml = renderToStaticMarkup(
      createElement(PluginErrorFallback, {
        pluginId: "demo-plugin",
        pluginName: "Demo Plugin",
        slot: "threadPanel",
        errorMessage: "Card crash",
        compact: true,
        onReload,
        onDisable,
      }),
    );
    expect(compactHtml).toContain("Plugin Demo Plugin failed to render");
    expect(compactHtml).toContain("Card crash");

    const fallbackTree = PluginErrorFallback({
      pluginId: "demo-plugin",
      pluginName: "Demo Plugin",
      slot: "mainView",
      errorMessage: "Hooks mismatch",
      onReload,
      onDisable,
    });
    const buttons = findButtons(fallbackTree);
    const reloadButton = buttons.find((button) => button.label.includes("Reload plugin"));
    const disableButton = buttons.find((button) => button.label.includes("Disable plugin"));

    expect(reloadButton).toBeDefined();
    expect(disableButton).toBeDefined();

    reloadButton?.onClick?.();
    disableButton?.onClick?.();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onDisable).toHaveBeenCalledTimes(1);
  });
});
