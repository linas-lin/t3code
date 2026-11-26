export const REDACTED_VALUE = "[REDACTED]";
export const REDACTED_PRIVATE_KEY = "[REDACTED_PRIVATE_KEY]";

export interface SanitizePersonalTextResult {
  readonly text: string;
  readonly redactedCount: number;
}

const PEM_PRIVATE_KEY_CLOSED_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_PRIVATE_KEY_UNCLOSED_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g;

const KNOWN_TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI / Anthropic / Stripe secret keys
  /\bsk-(?:proj-|ant-[A-Za-z0-9_-]+-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  // GitLab personal access tokens
  /\bglpat-[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/g,
  // npm access tokens
  /\bnpm_[A-Za-z0-9]{16,}\b/g,
  // PyPI API tokens
  /\bpypi-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
  // Hugging Face user access tokens
  /\bhf_[A-Za-z0-9]{16,}\b/g,
  // SendGrid API keys
  /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
  // Slack tokens (xoxb-, xoxa-, xoxp-, xoxr-, xoxs-)
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS access key IDs
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  // Standalone JWTs (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
];

// URL / database connection strings with embedded credentials, e.g. `postgres://user:pass@host`.
// Preserves scheme, username, and host for debugging while redacting the password.
const URL_EMBEDDED_CREDENTIALS_PATTERN =
  /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/:?#@"'`<>]*):([^\s/?#@"'`<>]+)@(?=[^\s/"'`<>])/g;

const BEARER_TOKEN_PATTERN = /\b(Bearer)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/gi;
const BASIC_TOKEN_PATTERN = /\b(Basic)([ \t]+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi;

// Matches standalone, snake_case, kebab-case, and camelCase sensitive key names.
const SENSITIVE_KEY_NAMES =
  "(?:[A-Za-z0-9_][A-Za-z0-9_-]*)?(?:password|passwd|pwd|token|secret(?:[_-]?key)?|api[_-]?key|private[_-]?key|set[_-]?cookie|cookie|authorization)";

// Quoted key-value pairs (JSON / YAML / TOML / env files), e.g. `"api_key": "value"`, `"accessToken": "value"`, or `password="value"`.
const QUOTED_SECRET_KV_PATTERN = new RegExp(
  `(["']?)\\b(${SENSITIVE_KEY_NAMES})\\1([ \\t]*[:=][ \\t]*)(["'])([^"'\\r\\n]+)\\4`,
  "gi",
);

// HTTP-style multi-token header lines for Authorization and Cookie headers, e.g.
// `Authorization: Basic dXNlcjpwYXNz` or `Cookie: sid=abc; theme=dark`.
const HEADER_SECRET_KV_PATTERN =
  /(^|[ \t])(authorization|cookie|set-cookie)([ \t]*:[ \t]*)([^\r\n]+)/gim;

// Unquoted single-token key-value pairs, e.g. `password=mysecret`, `api_key: abc123`, `accessToken=xyz`.
// Atomic `[REDACTED]` / `[REDACTED_PRIVATE_KEY]` tokens are matched whole so idempotent re-runs skip them.
const UNQUOTED_SECRET_KV_PATTERN = new RegExp(
  `\\b(${SENSITIVE_KEY_NAMES})([ \\t]*[:=][ \\t]*)(\\[REDACTED(?:_PRIVATE_KEY)?\\]|[^\\s,;\\r\\n"'\`\\]})]+)`,
  "gi",
);

const CJK_CHAR_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
const PURE_NUMBER_PATTERN = /^[+-]?\d+(?:\.\d+)?$/;

const SAFE_PLACEHOLDER_VALUES = new Set([
  REDACTED_VALUE.toLowerCase(),
  REDACTED_PRIVATE_KEY.toLowerCase(),
  "<redacted>",
  "***",
  "null",
  "undefined",
  "none",
  "true",
  "false",
]);

const SAFE_NON_CREDENTIAL_CONFIG_VALUES = new Set([
  "enabled",
  "disabled",
  "required",
  "optional",
  "auto",
  "default",
  "inherit",
  "manual",
  "off",
  "on",
  "yes",
  "no",
  "missing",
  "present",
  "valid",
  "invalid",
  "expired",
  "empty",
  "anonymous",
  "public",
  "private",
  "internal",
  "external",
  "oidc",
  "oauth",
  "oauth2",
  "jwt",
  "rbac",
  "abac",
  "acl",
  "sso",
  "saml",
  "mtls",
  "bearer",
  "basic",
  "digest",
  "ntlm",
  "negotiate",
  "apikey",
  "api-key",
  "api_key",
  "cookie",
  "session",
  "header",
  "query",
  "body",
  "strict",
  "lax",
  "httponly",
  "secure",
  "partitioned",
]);

const SAFE_COOKIE_ATTRIBUTE_PATTERN =
  /^(?:samesite=(?:lax|strict|none)|httponly|secure|partitioned|path=[^\s;]+|domain=[^\s;]+|max-age=-?\d+|expires=[^;]+|priority=(?:low|medium|high))$/i;

function isAlreadyRedactedOrSafePlaceholder(rawValue: string): boolean {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (SAFE_PLACEHOLDER_VALUES.has(lower)) {
    return true;
  }
  if (lower === `bearer ${REDACTED_VALUE.toLowerCase()}`) {
    return true;
  }
  if (lower === `basic ${REDACTED_VALUE.toLowerCase()}`) {
    return true;
  }
  if (trimmed === REDACTED_VALUE || trimmed === REDACTED_PRIVATE_KEY) {
    return true;
  }
  return false;
}

function isLikelyBasicCredential(token: string): boolean {
  if (token.length < 8) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
    return false;
  }
  if (token.includes("=") && token.length % 4 !== 0) {
    return false;
  }
  if (token.length % 4 === 1) {
    return false;
  }
  // If it cleanly decodes as printable ASCII `user:pass`, always treat it as a Basic credential.
  if (token.length % 4 === 0) {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    if (
      decoded.includes(":") &&
      /^[\x20-\x7e]+$/.test(decoded) &&
      Buffer.from(decoded, "utf8").toString("base64") === token
    ) {
      return true;
    }
  }
  // Reject ordinary English words (all lowercase, ALLCAPS, TitleCase, camelCase, PascalCase).
  if (
    /^[a-z]+$/.test(token) ||
    /^[A-Z]+$/.test(token) ||
    /^[A-Z][a-z]+$/.test(token) ||
    /^[A-Za-z][a-z]+(?:[A-Z][a-z]+)+$/.test(token)
  ) {
    return false;
  }
  return true;
}

function isCookieAttributeList(rawValue: string): boolean {
  const segments = rawValue
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return (
    segments.length > 0 && segments.every((segment) => SAFE_COOKIE_ATTRIBUTE_PATTERN.test(segment))
  );
}

function isRelaxedTechnicalKey(key: string): boolean {
  return /(?:token|authorization|cookie|set[_-]?cookie)$/i.test(key);
}

function isSafeNonCredentialHeaderValue(key: string, rawValue: string): boolean {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return true;
  }
  const lowerKey = key.toLowerCase();
  if (PURE_NUMBER_PATTERN.test(trimmed)) {
    return true;
  }
  if (SAFE_NON_CREDENTIAL_CONFIG_VALUES.has(trimmed.toLowerCase())) {
    return true;
  }
  if ((lowerKey === "cookie" || lowerKey === "set-cookie") && isCookieAttributeList(trimmed)) {
    return true;
  }
  // Chinese natural-language explanation (e.g. `Authorization: 需要走 RBAC 校验`),
  // provided it does not contain a non-attribute `key=value` cookie pair.
  if (CJK_CHAR_PATTERN.test(trimmed)) {
    if (lowerKey === "cookie" || lowerKey === "set-cookie") {
      const pairs = trimmed.match(/[A-Za-z0-9_.-]+=[^\s;]+/g) ?? [];
      if (pairs.some((pair) => !SAFE_COOKIE_ATTRIBUTE_PATTERN.test(pair))) {
        return false;
      }
    }
    const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
    if (
      CJK_CHAR_PATTERN.test(firstToken) ||
      SAFE_NON_CREDENTIAL_CONFIG_VALUES.has(firstToken.toLowerCase()) ||
      SAFE_COOKIE_ATTRIBUTE_PATTERN.test(firstToken)
    ) {
      return true;
    }
  }
  return false;
}

function isSafeNonCredentialUnquotedValue(key: string, rawValue: string): boolean {
  if (!isRelaxedTechnicalKey(key)) {
    return false;
  }
  const trimmed = rawValue.trim();
  if (PURE_NUMBER_PATTERN.test(trimmed)) {
    return true;
  }
  if (CJK_CHAR_PATTERN.test(trimmed)) {
    return true;
  }
  if (SAFE_NON_CREDENTIAL_CONFIG_VALUES.has(trimmed.toLowerCase())) {
    return true;
  }
  if (/(?:cookie|set[_-]?cookie)$/i.test(key) && isCookieAttributeList(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Redacts high-risk credentials (API keys, GitHub/GitLab/npm/PyPI/HuggingFace/SendGrid/Slack/
 * AWS/Google tokens, standalone JWTs, URL embedded credentials, Bearer/Basic tokens,
 * PEM private key blocks, and sensitive key-value pairs) before any text is written to disk.
 * Pure and idempotent: running it again on already sanitized output yields `redactedCount: 0`.
 */
export function sanitizePersonalText(text: string): SanitizePersonalTextResult {
  let result = text;
  let redactedCount = 0;

  // 1. PEM private key blocks (closed blocks first, then any truncated/unclosed block).
  result = result.replace(PEM_PRIVATE_KEY_CLOSED_PATTERN, () => {
    redactedCount += 1;
    return REDACTED_PRIVATE_KEY;
  });
  result = result.replace(PEM_PRIVATE_KEY_UNCLOSED_PATTERN, () => {
    redactedCount += 1;
    return REDACTED_PRIVATE_KEY;
  });

  // 2. High-entropy known provider/service token prefixes and standalone JWTs.
  for (const pattern of KNOWN_TOKEN_PATTERNS) {
    result = result.replace(pattern, () => {
      redactedCount += 1;
      return REDACTED_VALUE;
    });
  }

  // 3. URL / database connection string embedded credentials (preserve scheme, user, and host).
  result = result.replace(
    URL_EMBEDDED_CREDENTIALS_PATTERN,
    (match, scheme: string, user: string, password: string) => {
      if (isAlreadyRedactedOrSafePlaceholder(password)) {
        return match;
      }
      redactedCount += 1;
      return `${scheme}${user}:${REDACTED_VALUE}@`;
    },
  );

  // 4. Bearer <token> and Basic <base64>.
  result = result.replace(
    BEARER_TOKEN_PATTERN,
    (match, scheme: string, spaces: string, token: string) => {
      if (isAlreadyRedactedOrSafePlaceholder(token)) {
        return match;
      }
      redactedCount += 1;
      return `${scheme}${spaces}${REDACTED_VALUE}`;
    },
  );
  result = result.replace(
    BASIC_TOKEN_PATTERN,
    (match, scheme: string, spaces: string, token: string) => {
      if (isAlreadyRedactedOrSafePlaceholder(token) || !isLikelyBasicCredential(token)) {
        return match;
      }
      redactedCount += 1;
      return `${scheme}${spaces}${REDACTED_VALUE}`;
    },
  );

  // 5. Quoted sensitive key-value pairs.
  result = result.replace(
    QUOTED_SECRET_KV_PATTERN,
    (
      match,
      keyQuote: string,
      key: string,
      separator: string,
      valueQuote: string,
      value: string,
    ) => {
      if (isAlreadyRedactedOrSafePlaceholder(value)) {
        return match;
      }
      redactedCount += 1;
      return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED_VALUE}${valueQuote}`;
    },
  );

  // 6. Unquoted HTTP-style Authorization / Cookie header values (may span spaces/semicolons).
  result = result.replace(
    HEADER_SECRET_KV_PATTERN,
    (match, prefix: string, key: string, separator: string, value: string) => {
      const trimmed = value.trim();
      // Quoted values were already handled in step 5.
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        isAlreadyRedactedOrSafePlaceholder(trimmed) ||
        isSafeNonCredentialHeaderValue(key, trimmed)
      ) {
        return match;
      }
      redactedCount += 1;
      return `${prefix}${key}${separator}${REDACTED_VALUE}`;
    },
  );

  // 7. Unquoted single-token key-value pairs.
  result = result.replace(
    UNQUOTED_SECRET_KV_PATTERN,
    (match, key: string, separator: string, value: string, offset: number, fullString: string) => {
      if (
        isAlreadyRedactedOrSafePlaceholder(value) ||
        isSafeNonCredentialUnquotedValue(key, value)
      ) {
        return match;
      }
      if (
        key.toLowerCase() === "authorization" &&
        /^(?:bearer|basic)$/i.test(value) &&
        /^[ \t]+\[REDACTED\]/i.test(fullString.slice(offset + match.length))
      ) {
        return match;
      }
      redactedCount += 1;
      return `${key}${separator}${REDACTED_VALUE}`;
    },
  );

  return { text: result, redactedCount };
}

/** Returns true if the input contains any credential pattern that would be redacted. */
export function hasPotentialSecret(text: string): boolean {
  return sanitizePersonalText(text).redactedCount > 0;
}
