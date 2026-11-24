import { formatHex, formatHex8, parse } from "culori";

import { monaco } from "./monacoWorkers";

const IDE_DIFF_DARK_THEME = "t3-ide-dark";
const IDE_DIFF_LIGHT_THEME = "t3-ide-light";

function toMonacoHex(cssValue: string | undefined, fallback: string): string {
  if (!cssValue) return fallback;
  const trimmed = cssValue.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = parse(trimmed);
    if (!parsed) return fallback;
    const hasAlpha = typeof parsed.alpha === "number" && parsed.alpha < 1;
    const formatted = hasAlpha ? formatHex8(parsed) : formatHex(parsed);
    return formatted ?? fallback;
  } catch {
    return fallback;
  }
}

function readCssVar(styles: CSSStyleDeclaration | null, name: string): string | undefined {
  if (!styles) return undefined;
  return styles.getPropertyValue(name).trim() || undefined;
}

export function syncMonacoTheme(resolvedTheme: "light" | "dark"): string {
  const themeName = resolvedTheme === "dark" ? IDE_DIFF_DARK_THEME : IDE_DIFF_LIGHT_THEME;
  const styles =
    typeof window !== "undefined" && typeof document !== "undefined"
      ? window.getComputedStyle(document.documentElement)
      : null;

  const isDark = resolvedTheme === "dark";
  const background = toMonacoHex(
    readCssVar(styles, "--code-background") ?? readCssVar(styles, "--background"),
    isDark ? "#14161a" : "#ffffff",
  );
  const foreground = toMonacoHex(
    readCssVar(styles, "--code-foreground") ?? readCssVar(styles, "--foreground"),
    isDark ? "#e4e7ee" : "#1d222b",
  );
  const mutedForeground = toMonacoHex(
    readCssVar(styles, "--muted-foreground"),
    isDark ? "#7c8596" : "#6c7586",
  );
  const border = toMonacoHex(readCssVar(styles, "--border"), isDark ? "#282c34" : "#e2e6ee");
  const primary = toMonacoHex(readCssVar(styles, "--primary"), isDark ? "#4f8cff" : "#2563eb");

  monaco.editor.defineTheme(themeName, {
    base: isDark ? "vs-dark" : "vs",
    inherit: true,
    rules: isDark
      ? [
          { token: "comment", foreground: "7a8494", fontStyle: "italic" },
          { token: "comment.doc", foreground: "5f826b", fontStyle: "italic" },
          { token: "comment.doc.tag", foreground: "88b395", fontStyle: "bold italic" },
          { token: "keyword", foreground: "cf8e6d" },
          { token: "annotation", foreground: "b3ae60" },
          { token: "string", foreground: "6aab73" },
          { token: "string.escape", foreground: "cf8e6d" },
          { token: "number", foreground: "2aacb8" },
          { token: "type", foreground: "6fafbd" },
          { token: "type.identifier", foreground: "6fafbd" },
          { token: "function", foreground: "56a8f5" },
          { token: "constant", foreground: "c77dbb", fontStyle: "italic" },
          { token: "variable.property", foreground: "c77dbb" },
          { token: "variable.predefined", foreground: "cf8e6d" },
          { token: "attribute.name", foreground: "b3ae60" },
          { token: "tag", foreground: "d5b778" },
          { token: "identifier", foreground: "bcbec4" },
          { token: "delimiter", foreground: "9da3ae" },
          { token: "regexp", foreground: "42c3d4" },
        ]
      : [
          { token: "comment", foreground: "8c8c8c", fontStyle: "italic" },
          { token: "comment.doc", foreground: "629755", fontStyle: "italic" },
          { token: "comment.doc.tag", foreground: "3d7a32", fontStyle: "bold italic" },
          { token: "keyword", foreground: "0033b3" },
          { token: "annotation", foreground: "9e880d" },
          { token: "string", foreground: "067d17" },
          { token: "string.escape", foreground: "0037a6" },
          { token: "number", foreground: "1750eb" },
          { token: "type", foreground: "00627a" },
          { token: "type.identifier", foreground: "00627a" },
          { token: "function", foreground: "00627a" },
          { token: "constant", foreground: "871094", fontStyle: "italic" },
          { token: "variable.property", foreground: "871094" },
          { token: "variable.predefined", foreground: "0033b3" },
          { token: "attribute.name", foreground: "9e880d" },
          { token: "tag", foreground: "0033b3" },
          { token: "delimiter", foreground: "5b6370" },
        ],
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": mutedForeground,
      "editorLineNumber.activeForeground": foreground,
      "editorGutter.background": background,
      "editor.lineHighlightBackground": isDark ? "#ffffff09" : "#00000006",
      "editor.selectionBackground": isDark ? "#2f6feb44" : "#2563eb2a",
      "editor.findMatchBackground": isDark ? "#ff963266" : "#ff963288",
      "editor.findMatchHighlightBackground": isDark ? "#ff963233" : "#ff963244",
      "editorWidget.background": isDark ? "#1c1f26" : "#f8fafc",
      "editorWidget.border": border,
      focusBorder: primary,
      // IntelliJ IDEA inspired diff palette (soft line fills + crisp char-level highlights)
      "diffEditor.insertedLineBackground": isDark ? "#234a3240" : "#d6f5df90",
      "diffEditor.insertedTextBackground": isDark ? "#2ea04352" : "#7ee09878",
      "diffEditor.removedLineBackground": isDark ? "#5c232944" : "#ffdce096",
      "diffEditor.removedTextBackground": isDark ? "#f8514954" : "#ff949c78",
      "diffEditor.diagonalFill": isDark ? "#ffffff12" : "#0000000e",
      "diffEditor.border": border,
      "diffEditorGutter.insertedLineBackground": isDark ? "#2ea04328" : "#2ea04320",
      "diffEditorGutter.removedLineBackground": isDark ? "#f8514928" : "#f8514920",
      "diffEditorOverview.insertedForeground": isDark ? "#3fb950cc" : "#1a7f37cc",
      "diffEditorOverview.removedForeground": isDark ? "#f85149cc" : "#cf222ecc",
      "diffEditor.unchangedRegionBackground": isDark ? "#1b1f27" : "#f3f5f8",
      "diffEditor.unchangedRegionForeground": mutedForeground,
      "diffEditor.unchangedCodeBackground": isDark ? "#181b2180" : "#f6f8fa80",
      "scrollbarSlider.background": isDark ? "#ffffff18" : "#00000018",
      "scrollbarSlider.hoverBackground": isDark ? "#ffffff2e" : "#0000002e",
      "scrollbarSlider.activeBackground": isDark ? "#ffffff40" : "#00000040",
    },
  });

  monaco.editor.setTheme(themeName);
  return themeName;
}
