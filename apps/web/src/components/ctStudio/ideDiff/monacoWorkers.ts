import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";

let initialized = false;

function registerLightweightJsonLanguage(): void {
  const existing = monaco.languages.getLanguages().some((language) => language.id === "json");
  if (existing) return;

  monaco.languages.register({
    id: "json",
    extensions: [".json", ".jsonc", ".json5"],
    aliases: ["JSON", "json"],
    mimetypes: ["application/json"],
  });

  monaco.languages.setMonarchTokensProvider("json", {
    tokenizer: {
      root: [
        [/[{}[\]]/, "@brackets"],
        [/[:,]/, "delimiter"],
        [/"(?:\\.|[^"\\])*"(?=\s*:)/, "type.identifier"],
        [/"(?:\\.|[^"\\])*"/, "string"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
        [/\b(?:true|false|null)\b/, "keyword"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });
}

export function ensureMonacoInitialized(): void {
  if (initialized) return;
  initialized = true;

  const globalScope = globalThis as {
    MonacoEnvironment?: {
      getWorker?: (workerId: string, label: string) => Worker;
    };
  };

  if (!globalScope.MonacoEnvironment?.getWorker) {
    globalScope.MonacoEnvironment = {
      ...globalScope.MonacoEnvironment,
      getWorker: () => new EditorWorker(),
    };
  }

  registerLightweightJsonLanguage();
}

export { monaco };
