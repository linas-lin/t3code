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

function registerEnhancedJavaLanguage(): void {
  const existing = monaco.languages.getLanguages().some((language) => language.id === "java");
  if (!existing) {
    monaco.languages.register({
      id: "java",
      extensions: [".java", ".jav"],
      aliases: ["Java", "java"],
      mimetypes: ["text/x-java-source", "text/x-java"],
    });
  }

  monaco.languages.setMonarchTokensProvider("java", {
    defaultToken: "",
    tokenPostfix: ".java",
    keywords: [
      "abstract",
      "assert",
      "boolean",
      "break",
      "byte",
      "case",
      "catch",
      "char",
      "class",
      "const",
      "continue",
      "default",
      "do",
      "double",
      "else",
      "enum",
      "extends",
      "false",
      "final",
      "finally",
      "float",
      "for",
      "goto",
      "if",
      "implements",
      "import",
      "instanceof",
      "int",
      "interface",
      "long",
      "native",
      "new",
      "non-sealed",
      "null",
      "package",
      "permits",
      "private",
      "protected",
      "public",
      "record",
      "return",
      "sealed",
      "short",
      "static",
      "strictfp",
      "super",
      "switch",
      "synchronized",
      "this",
      "throw",
      "throws",
      "transient",
      "true",
      "try",
      "var",
      "void",
      "volatile",
      "while",
      "yield",
    ],
    operators: [
      "=",
      ">",
      "<",
      "!",
      "~",
      "?",
      ":",
      "==",
      "<=",
      ">=",
      "!=",
      "&&",
      "||",
      "++",
      "--",
      "+",
      "-",
      "*",
      "/",
      "&",
      "|",
      "^",
      "%",
      "<<",
      ">>",
      ">>>",
      "+=",
      "-=",
      "*=",
      "/=",
      "&=",
      "|=",
      "^=",
      "%=",
      "<<=",
      ">>=",
      ">>>=",
      "->",
      "::",
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    digits: /\d+(_+\d+)*/,
    octaldigits: /[0-7]+(_+[0-7]+)*/,
    binarydigits: /[0-1]+(_+[0-1]+)*/,
    hexdigits: /[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,
    tokenizer: {
      root: [
        ["non-sealed", "keyword.non-sealed"],
        // Annotations (@Override, @Inject, @javax.annotation.Nullable)
        [/@\s*[a-zA-Z_$][\w$.]*/, "annotation"],
        // Member method calls, constants, and field accesses after '.'
        [/(\.)([a-z_$][\w$]*)(?=\s*\()/, ["delimiter", "function"]],
        [/(\.)([A-Z][A-Z0-9_]{1,})\b/, ["delimiter", "constant"]],
        [/(\.)([a-z_$][\w$]*)/, ["delimiter", "variable.property"]],
        // Method declarations & direct calls (excluding control keywords like if(...))
        [
          /[a-z_$][\w$]*(?=\s*\()/,
          {
            cases: {
              "@keywords": { token: "keyword.$0" },
              "@default": "function",
            },
          },
        ],
        // ALL_CAPS constants / enum members
        [/[A-Z][A-Z0-9_]{1,}\b/, "constant"],
        // PascalCase classes, interfaces, and single-letter generic parameters
        [/[A-Z][\w$]*/, "type.identifier"],
        // Remaining keywords & identifiers
        [
          /[a-zA-Z_$][\w$]*/,
          {
            cases: {
              "@keywords": { token: "keyword.$0" },
              "@default": "identifier",
            },
          },
        ],
        { include: "@whitespace" },
        [/[{}()[\]]/, "@brackets"],
        [/[<>](?!@symbols)/, "@brackets"],
        [
          /@symbols/,
          {
            cases: {
              "@operators": "delimiter",
              "@default": "",
            },
          },
        ],
        [/(@digits)[eE]([-+]?(@digits))?[fFdD]?/, "number.float"],
        [/(@digits)\.(@digits)([eE][-+]?(@digits))?[fFdD]?/, "number.float"],
        [/0[xX](@hexdigits)[Ll]?/, "number.hex"],
        [/0(@octaldigits)[Ll]?/, "number.octal"],
        [/0[bB](@binarydigits)[Ll]?/, "number.binary"],
        [/(@digits)[fFdD]/, "number.float"],
        [/(@digits)[lL]?/, "number"],
        [/[;,.]/, "delimiter"],
        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"""/, "string", "@multistring"],
        [/"/, "string", "@string"],
        [/'[^\\']'/, "string"],
        [/(')(@escapes)(')/, ["string", "string.escape", "string"]],
        [/'/, "string.invalid"],
      ],
      whitespace: [
        [/[ \t\r\n]+/, ""],
        [/\/\*\*(?!\/)/, "comment.doc", "@javadoc"],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
      javadoc: [
        [/@[a-zA-Z]+/, "comment.doc.tag"],
        [/[^/*@]+/, "comment.doc"],
        [/\*\//, "comment.doc", "@pop"],
        [/[/*@]/, "comment.doc"],
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],
      multistring: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"""/, "string", "@pop"],
        [/./, "string"],
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
  registerEnhancedJavaLanguage();
}

export { monaco };
