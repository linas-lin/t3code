import { assert, describe, it } from "@effect/vitest";

import {
  REDACTED_PRIVATE_KEY,
  REDACTED_VALUE,
  hasPotentialSecret,
  sanitizePersonalText,
} from "./personalSanitizer.ts";

describe("personalSanitizer", () => {
  it("redacts known high-risk token prefixes", () => {
    const samples = [
      ["openai=sk", "-proj-abc1234567890XYZDEF1234567890"].join(""),
      ["anthropic: sk", "-ant-api03-abcdefghijklmnop1234567890"].join(""),
      ["github classic gh", "p_1234567890abcdefABCDEF1234567890abcd"].join(""),
      ["github oauth gh", "o_1234567890abcdefABCDEF1234567890abcd"].join(""),
      ["gitlab pat gl", "pat-1234567890abcdefABCD"].join(""),
      ["npm token np", "m_1234567890abcdefABCDEF1234567890"].join(""),
      ["pypi token py", "pi-AgEIcHlwaS5vcmc1234567890abcdef"].join(""),
      ["huggingface token h", "f_1234567890abcdefABCDEF1234567890"].join(""),
      ["sendgrid key S", "G.1234567890abcdef.1234567890abcdefABCDEF"].join(""),
      ["slack bot xo", "xb-1234567890-1234567890-abcdefghijklmnop"].join(""),
      ["slack user xo", "xp-1234567890-1234567890-abcdefghijklmnop"].join(""),
      ["aws key AK", "IAIOSFODNN7EXAMPLE"].join(""),
      ["google key AI", "zaSyD-1234567890abcdefghijkLMNOPQRS"].join(""),
    ];

    for (const sample of samples) {
      assert.isTrue(hasPotentialSecret(sample), `expected secret in: ${sample}`);
      const sanitized = sanitizePersonalText(sample);
      assert.isAbove(sanitized.redactedCount, 0);
      assert.include(sanitized.text, REDACTED_VALUE);
      // Idempotent second pass
      const second = sanitizePersonalText(sanitized.text);
      assert.strictEqual(second.redactedCount, 0);
      assert.strictEqual(second.text, sanitized.text);
    }
  });

  it("redacts standalone JWTs, Basic base64 credentials, and URL embedded passwords", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwtSanitized = sanitizePersonalText(`decoded jwt: ${jwt}`);
    assert.strictEqual(jwtSanitized.redactedCount, 1);
    assert.strictEqual(jwtSanitized.text, `decoded jwt: ${REDACTED_VALUE}`);
    assert.strictEqual(sanitizePersonalText(jwtSanitized.text).redactedCount, 0);

    const basicStandalone = sanitizePersonalText("Use Basic dXNlcjpwYXNz when curling staging");
    assert.strictEqual(basicStandalone.redactedCount, 1);
    assert.strictEqual(basicStandalone.text, `Use Basic ${REDACTED_VALUE} when curling staging`);
    assert.strictEqual(sanitizePersonalText(basicStandalone.text).redactedCount, 0);

    const basicPadded = sanitizePersonalText("Basic YWJjZGVmZ2g=");
    assert.strictEqual(basicPadded.redactedCount, 1);
    assert.strictEqual(basicPadded.text, `Basic ${REDACTED_VALUE}`);
    assert.strictEqual(sanitizePersonalText(basicPadded.text).redactedCount, 0);

    const urls = [
      {
        input: "postgres://admin:S3cr3tPass@db.internal:5432/app",
        expected: `postgres://admin:${REDACTED_VALUE}@db.internal:5432/app`,
      },
      {
        input:
          "mongodb+srv://app_user:MyP4ssw0rd!@cluster0.abcde.mongodb.net/prod?retryWrites=true",
        expected: `mongodb+srv://app_user:${REDACTED_VALUE}@cluster0.abcde.mongodb.net/prod?retryWrites=true`,
      },
      {
        input: "https://deploy:token_pass_99@git.example.com/org/repo.git",
        expected: `https://deploy:${REDACTED_VALUE}@git.example.com/org/repo.git`,
      },
      {
        input: "redis://:redisSecret123@127.0.0.1:6379/0",
        expected: `redis://:${REDACTED_VALUE}@127.0.0.1:6379/0`,
      },
    ];

    for (const testCase of urls) {
      const sanitized = sanitizePersonalText(testCase.input);
      assert.strictEqual(sanitized.redactedCount, 1, `expected 1 redaction for ${testCase.input}`);
      assert.strictEqual(sanitized.text, testCase.expected);
      const second = sanitizePersonalText(sanitized.text);
      assert.strictEqual(second.redactedCount, 0);
      assert.strictEqual(second.text, sanitized.text);
    }
  });

  it("redacts Bearer tokens and preserves the Bearer prefix", () => {
    const input = "Header -> Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def";
    const sanitized = sanitizePersonalText(input);
    assert.strictEqual(sanitized.redactedCount, 1);
    assert.strictEqual(sanitized.text, `Header -> Authorization: Bearer ${REDACTED_VALUE}`);
    assert.isFalse(hasPotentialSecret(sanitized.text));
  });

  it("redacts PEM private key blocks (closed and truncated)", () => {
    const pem = [
      "Note before key",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7Mhgw",
      "-----END RSA PRIVATE KEY-----",
      "Note after key",
    ].join("\n");

    const sanitized = sanitizePersonalText(pem);
    assert.strictEqual(sanitized.redactedCount, 1);
    assert.strictEqual(sanitized.text, `Note before key\n${REDACTED_PRIVATE_KEY}\nNote after key`);
    assert.isFalse(hasPotentialSecret(sanitized.text));

    const truncatedPem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw";
    const truncatedSanitized = sanitizePersonalText(truncatedPem);
    assert.strictEqual(truncatedSanitized.redactedCount, 1);
    assert.strictEqual(truncatedSanitized.text, REDACTED_PRIVATE_KEY);
  });

  it("redacts sensitive key-value pairs across env, JSON, and header formats", () => {
    const input = [
      "password=SuperSecretPassword123!",
      '{"api_key": "my-secret-api-value", "client_secret": "shhh-999"}',
      "token: local_session_value_42",
      "Cookie: sid=abc123; csrftoken=xyz789",
      "Authorization: Basic dXNlcjpwYXNz",
    ].join("\n");

    const sanitized = sanitizePersonalText(input);
    assert.strictEqual(sanitized.redactedCount, 6);
    assert.notInclude(sanitized.text, "SuperSecretPassword123!");
    assert.notInclude(sanitized.text, "my-secret-api-value");
    assert.notInclude(sanitized.text, "shhh-999");
    assert.notInclude(sanitized.text, "local_session_value_42");
    assert.notInclude(sanitized.text, "csrftoken=xyz789");
    assert.notInclude(sanitized.text, "dXNlcjpwYXNz");
    assert.include(sanitized.text, `password=${REDACTED_VALUE}`);
    assert.include(sanitized.text, `"api_key": "${REDACTED_VALUE}"`);
    assert.include(sanitized.text, `Cookie: ${REDACTED_VALUE}`);
    assert.include(sanitized.text, `Authorization: Basic ${REDACTED_VALUE}`);

    // Idempotent second pass
    const second = sanitizePersonalText(sanitized.text);
    assert.strictEqual(second.redactedCount, 0);
    assert.strictEqual(second.text, sanitized.text);
  });

  it("redacts camelCase, snake_case, and kebab-case sensitive key-value pairs (quoted and unquoted)", () => {
    const quotedJson = JSON.stringify({
      accessToken: "at_live_123456",
      refreshToken: "rt_live_abcdef",
      idToken: "id_live_987654",
      clientSecret: "cs_secret_value",
      dbPassword: "DbPassword!99",
      openaiApiKey: "custom_openai_val_42",
      sessionCookie: "sid_cookie_xyz",
      jwtSecret: "jwt_signing_key_88",
      "x-api-key": "kebab_api_key_value",
      private_key: "inline_private_val",
    });

    const sanitizedJson = sanitizePersonalText(quotedJson);
    assert.strictEqual(sanitizedJson.redactedCount, 10);
    for (const leak of [
      "at_live_123456",
      "rt_live_abcdef",
      "id_live_987654",
      "cs_secret_value",
      "DbPassword!99",
      "custom_openai_val_42",
      "sid_cookie_xyz",
      "jwt_signing_key_88",
      "kebab_api_key_value",
      "inline_private_val",
    ]) {
      assert.notInclude(sanitizedJson.text, leak);
    }
    assert.strictEqual(sanitizePersonalText(sanitizedJson.text).redactedCount, 0);

    const unquoted = [
      "accessToken=at_unquoted_111",
      "refreshToken: rt_unquoted_222",
      "idToken=id_unquoted_333",
      "clientSecret: cs_unquoted_444",
      "dbPassword=db_unquoted_555",
      "openaiApiKey: oa_unquoted_666",
      "sessionCookie=sc_unquoted_777",
      "jwtSecret: js_unquoted_888",
      "x-api-key: kebab_unquoted_999",
      "Authorization: Token custom_scheme_secret_000",
    ].join("\n");

    const sanitizedUnquoted = sanitizePersonalText(unquoted);
    assert.strictEqual(sanitizedUnquoted.redactedCount, 10);
    for (const leak of [
      "at_unquoted_111",
      "rt_unquoted_222",
      "id_unquoted_333",
      "cs_unquoted_444",
      "db_unquoted_555",
      "oa_unquoted_666",
      "sc_unquoted_777",
      "js_unquoted_888",
      "kebab_unquoted_999",
      "custom_scheme_secret_000",
    ]) {
      assert.notInclude(sanitizedUnquoted.text, leak);
    }
    assert.include(sanitizedUnquoted.text, `accessToken=${REDACTED_VALUE}`);
    assert.include(sanitizedUnquoted.text, `openaiApiKey: ${REDACTED_VALUE}`);
    assert.include(sanitizedUnquoted.text, `Authorization: ${REDACTED_VALUE}`);
    assert.strictEqual(sanitizePersonalText(sanitizedUnquoted.text).redactedCount, 0);
  });

  it("does not trigger false positives on ordinary technical discussion, numbers, Chinese prose, or safe config values", () => {
    const input = [
      "沟通偏好：结论先行，不要记录任何 password、token 或 cookie 到笔记。",
      "require_password: false",
      "token: null",
      "secret: [REDACTED]",
      "token: 3200",
      "max_tokens: 4096",
      "max_token: 4096",
      "contextToken: 128000",
      "Authorization: 需要走 RBAC 校验",
      "Authorization: RBAC",
      "cookie: SameSite=Lax",
      "Cookie: SameSite=Strict; HttpOnly; Secure",
      "Set-Cookie: Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
      "Basic authentication flow and Basic AuthFlow overview",
      "https://example.com:8080/path?email=user@example.com",
    ].join("\n");

    assert.isFalse(hasPotentialSecret(input));
    const sanitized = sanitizePersonalText(input);
    assert.strictEqual(sanitized.redactedCount, 0);
    assert.strictEqual(sanitized.text, input);
  });
});
