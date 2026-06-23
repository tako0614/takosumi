#!/usr/bin/env bun
/**
 * Takosumi Cloud-only extension smoke.
 *
 * This verifies the hosted platform worker's Cloud-only service-binding seam
 * and the closed extension workers mounted behind it. It intentionally stores
 * only redacted response summaries: no session token, cookie, bearer, or token
 * file path is written to the evidence JSON.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import process from "node:process";

export const CLOUD_EXTENSION_SMOKE_KIND =
  "takosumi.cloud-extension-smoke@v1" as const;

const CLOUDFLARE_COMPAT_ACCOUNT_ID = "ts_acc_takosumi_cloud";
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT = "takosumi-smoke";
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT_PATH = `/compat/cloudflare/client/v4/accounts/${CLOUDFLARE_COMPAT_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_COMPAT_SMOKE_SCRIPT}`;
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT_BODY =
  "export default { fetch() { return new Response('takosumi smoke'); } };";

type FetchLike = typeof fetch;

export interface CloudExtensionSmokeOptions {
  readonly url: string;
  readonly sessionToken: string;
  readonly sessionTokenSource: "env" | "file";
  readonly outFile?: string;
  readonly json: boolean;
  readonly requireCompatMaterialization: boolean;
  readonly platformVersion?: string;
  readonly aiGatewayVersion?: string;
  readonly cloudflareCompatVersion?: string;
}

export interface CloudExtensionSmokeCheck {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
  readonly expected: string;
  readonly summary: Record<string, unknown>;
}

export interface CloudExtensionSmokeResult {
  readonly kind: typeof CLOUD_EXTENSION_SMOKE_KIND;
  readonly status: "passed" | "failed";
  readonly gaReady: boolean;
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly sessionTokenSource: "env" | "file";
  readonly requireCompatMaterialization: boolean;
  readonly platformVersion?: string;
  readonly extensionVersions?: {
    readonly aiGateway?: string;
    readonly cloudflareCompat?: string;
  };
  readonly checks: readonly CloudExtensionSmokeCheck[];
  readonly gaps: readonly string[];
  readonly safety: string;
}

interface CliArgs {
  readonly help?: boolean;
  readonly selfTest?: boolean;
  readonly url?: string;
  readonly sessionTokenFile?: string;
  readonly outFile?: string;
  readonly json?: boolean;
  readonly requireCompatMaterialization?: boolean;
  readonly platformVersion?: string;
  readonly aiGatewayVersion?: string;
  readonly cloudflareCompatVersion?: string;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(exitCode);
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.selfTest) {
    await runSelfTest();
    return 0;
  }
  const options = await resolveOptions(args, process.env);
  const result = await runCloudExtensionSmoke(options);
  await writeResult(result, options);
  return result.status === "passed" ? 0 : 1;
}

export async function resolveOptions(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
): Promise<CloudExtensionSmokeOptions> {
  const url = args.url ?? env.TAKOSUMI_PLATFORM_URL;
  if (!url) throw new Error("--url or TAKOSUMI_PLATFORM_URL is required");
  const tokenFile =
    args.sessionTokenFile ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE;
  if (tokenFile) {
    const sessionToken = (await Bun.file(tokenFile).text()).trim();
    if (!sessionToken) throw new Error("session token file is empty");
    return {
      url: normalizeBaseUrl(url),
      sessionToken,
      sessionTokenSource: "file",
      outFile: args.outFile,
      json: args.json === true,
      requireCompatMaterialization: args.requireCompatMaterialization === true,
      platformVersion: optionalString(args.platformVersion),
      aiGatewayVersion: optionalString(args.aiGatewayVersion),
      cloudflareCompatVersion: optionalString(args.cloudflareCompatVersion),
    };
  }
  const sessionToken = env.TAKOSUMI_ACCOUNT_SESSION_TOKEN?.trim();
  if (!sessionToken) {
    throw new Error(
      "--session-token-file, TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE, or TAKOSUMI_ACCOUNT_SESSION_TOKEN is required",
    );
  }
  return {
    url: normalizeBaseUrl(url),
    sessionToken,
    sessionTokenSource: "env",
    outFile: args.outFile,
    json: args.json === true,
    requireCompatMaterialization: args.requireCompatMaterialization === true,
    platformVersion: optionalString(args.platformVersion),
    aiGatewayVersion: optionalString(args.aiGatewayVersion),
    cloudflareCompatVersion: optionalString(args.cloudflareCompatVersion),
  };
}

export async function runCloudExtensionSmoke(
  options: CloudExtensionSmokeOptions,
  fetchImpl: FetchLike = fetch,
): Promise<CloudExtensionSmokeResult> {
  const authHeaders = {
    authorization: `Bearer ${options.sessionToken}`,
    accept: "application/json",
  };
  const checks = [
    await requestCheck(fetchImpl, options, {
      name: "sessionMeAuth",
      path: "/v1/account/session/me",
      expected: "authenticated session mirror returns subject",
      headers: authHeaders,
      pass: (response, body) =>
        response.status === 200 &&
        record(body).subject !== undefined &&
        typeof record(body).subject === "string",
      summarize: (body) => ({
        subjectPresent: typeof record(body).subject === "string",
        primaryAccountIdPresent:
          typeof record(body).primaryAccountId === "string",
      }),
    }),
    await requestCheck(fetchImpl, options, {
      name: "aiModelsUnauth",
      path: "/gateway/ai/v1/models",
      expected: "unauthenticated AI model listing is rejected",
      pass: (response) => response.status === 401,
      summarize: summarizeOpenAiError,
    }),
    await requestCheck(fetchImpl, options, {
      name: "cloudflareCompatVerifyUnauth",
      path: "/compat/cloudflare/client/v4/user/tokens/verify",
      expected: "unauthenticated Cloudflare compat verify is rejected",
      pass: (response) => response.status === 401,
      summarize: summarizeCloudflareEnvelope,
    }),
    await requestCheck(fetchImpl, options, {
      name: "aiModelsAuth",
      path: "/gateway/ai/v1/models",
      expected: "authenticated AI model listing includes takosumi/default",
      headers: authHeaders,
      pass: (response, body) =>
        response.status === 200 && modelIds(body).includes("takosumi/default"),
      summarize: (body) => ({ modelIds: modelIds(body) }),
    }),
    await requestCheck(fetchImpl, options, {
      name: "aiChatAuth",
      path: "/gateway/ai/v1/chat/completions",
      method: "POST",
      expected: "authenticated OpenAI-compatible chat completion succeeds",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: {
        model: "takosumi/default",
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
      },
      pass: (response, body) =>
        response.status === 200 && choicesCount(body) > 0,
      summarize: (body) => ({
        choiceCount: choicesCount(body),
        model:
          typeof record(body).model === "string" ? record(body).model : null,
      }),
    }),
    await requestCheck(fetchImpl, options, {
      name: "aiEmbeddingsAuth",
      path: "/gateway/ai/v1/embeddings",
      method: "POST",
      expected: "authenticated OpenAI-compatible embeddings request succeeds",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: { model: "workers-ai/bge-base-en-v1.5", input: "takosumi" },
      pass: (response, body) =>
        response.status === 200 && embeddingsCount(body) > 0,
      summarize: (body) => ({
        embeddingCount: embeddingsCount(body),
        model:
          typeof record(body).model === "string" ? record(body).model : null,
      }),
    }),
    await requestCheck(fetchImpl, options, {
      name: "cloudflareCompatVerifyAuth",
      path: "/compat/cloudflare/client/v4/user/tokens/verify",
      expected: "authenticated Cloudflare token verify compatibility succeeds",
      headers: authHeaders,
      pass: (response, body) =>
        response.status === 200 && record(body).success === true,
      summarize: summarizeCloudflareEnvelope,
    }),
    await requestCheck(fetchImpl, options, {
      name: "cloudflareCompatAccountsAuth",
      path: "/compat/cloudflare/client/v4/accounts",
      expected: "authenticated Cloudflare accounts compatibility succeeds",
      headers: authHeaders,
      pass: (response, body) =>
        response.status === 200 &&
        record(body).success === true &&
        Array.isArray(record(body).result),
      summarize: (body) => ({
        success: record(body).success === true,
        accountCount: Array.isArray(record(body).result)
          ? record(body).result.length
          : 0,
      }),
    }),
    await requestCheck(fetchImpl, options, {
      name: "cloudflareCompatScriptsListAuth",
      path: `/compat/cloudflare/client/v4/accounts/${CLOUDFLARE_COMPAT_ACCOUNT_ID}/workers/scripts`,
      expected:
        "authenticated Cloudflare Workers scripts list compatibility succeeds",
      headers: authHeaders,
      pass: (response, body) =>
        response.status === 200 &&
        record(body).success === true &&
        Array.isArray(record(body).result),
      summarize: summarizeCloudflareEnvelope,
    }),
    await requestCheck(fetchImpl, options, {
      name: "cloudflareCompatScriptPutAuth",
      path: CLOUDFLARE_COMPAT_SMOKE_SCRIPT_PATH,
      method: "PUT",
      expected: options.requireCompatMaterialization
        ? "Cloudflare Workers script materialization accepts a script upload"
        : "Cloudflare Workers script materialization upload is either implemented or explicitly fail-closed",
      headers: { ...authHeaders, "content-type": "application/javascript" },
      bodyText: CLOUDFLARE_COMPAT_SMOKE_SCRIPT_BODY,
      pass: (response, body) => {
        if (
          (response.status === 200 || response.status === 201) &&
          record(body).success === true
        ) {
          return true;
        }
        return (
          !options.requireCompatMaterialization &&
          response.status === 501 &&
          record(body).success === false
        );
      },
      summarize: summarizeCloudflareEnvelope,
    }),
    await requestCheck(fetchImpl, options, {
      name: "cloudflareCompatScriptGetAuth",
      path: CLOUDFLARE_COMPAT_SMOKE_SCRIPT_PATH,
      expected: options.requireCompatMaterialization
        ? "Cloudflare Workers script materialization can read the uploaded script"
        : "Cloudflare Workers script materialization read is either implemented or explicitly fail-closed",
      headers: authHeaders,
      pass: (response, body) => {
        if (response.status === 200 && record(body).success === true) {
          return true;
        }
        return (
          !options.requireCompatMaterialization &&
          response.status === 501 &&
          record(body).success === false
        );
      },
      summarize: summarizeCloudflareEnvelope,
    }),
    await requestCheck(fetchImpl, options, {
      name: "cloudflareCompatScriptDeleteAuth",
      path: CLOUDFLARE_COMPAT_SMOKE_SCRIPT_PATH,
      method: "DELETE",
      expected: options.requireCompatMaterialization
        ? "Cloudflare Workers script materialization cleanup succeeds"
        : "Cloudflare Workers script materialization cleanup is either implemented or explicitly fail-closed",
      headers: authHeaders,
      pass: (response, body) => {
        if (response.status === 200 && record(body).success === true) {
          return true;
        }
        return (
          !options.requireCompatMaterialization &&
          response.status === 501 &&
          record(body).success === false
        );
      },
      summarize: summarizeCloudflareEnvelope,
    }),
  ];
  const gaps = cloudExtensionGaps(checks);
  const gaReady =
    checks.every((check) => check.ok) &&
    !gaps.includes("cloudflare_compat_materialization_not_enabled");
  const status =
    checks.every((check) => check.ok) &&
    (gaReady || !options.requireCompatMaterialization)
      ? "passed"
      : "failed";
  return {
    kind: CLOUD_EXTENSION_SMOKE_KIND,
    status,
    gaReady,
    generatedAt: new Date().toISOString(),
    serviceUrl: options.url,
    sessionTokenSource: options.sessionTokenSource,
    requireCompatMaterialization: options.requireCompatMaterialization,
    platformVersion: options.platformVersion,
    extensionVersions:
      options.aiGatewayVersion || options.cloudflareCompatVersion
        ? {
            aiGateway: options.aiGatewayVersion,
            cloudflareCompat: options.cloudflareCompatVersion,
          }
        : undefined,
    checks,
    gaps,
    safety:
      "Authenticated smoke uses a Takosumi account session only for request headers; evidence stores status codes and redacted response summaries, never bearer/cookie/session material.",
  };
}

interface RequestCheckInput {
  readonly name: string;
  readonly path: string;
  readonly method?: string;
  readonly expected: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly bodyText?: string;
  readonly pass: (response: Response, body: unknown) => boolean;
  readonly summarize: (body: unknown) => Record<string, unknown>;
}

async function requestCheck(
  fetchImpl: FetchLike,
  options: CloudExtensionSmokeOptions,
  input: RequestCheckInput,
): Promise<CloudExtensionSmokeCheck> {
  const method = input.method ?? "GET";
  const response = await fetchImpl(`${options.url}${input.path}`, {
    method,
    headers: input.headers,
    body:
      input.bodyText ??
      (input.body === undefined ? undefined : JSON.stringify(input.body)),
  });
  const body = await readJson(response);
  return {
    name: input.name,
    method,
    path: input.path,
    status: response.status,
    ok: input.pass(response, body),
    expected: input.expected,
    summary: input.summarize(body),
  };
}

function cloudExtensionGaps(
  checks: readonly CloudExtensionSmokeCheck[],
): string[] {
  const gaps: string[] = [];
  const materialization = checks.find(
    (check) =>
      check.name === "cloudflareCompatScriptPutAuth" && check.status === 501,
  );
  if (materialization) {
    gaps.push("cloudflare_compat_materialization_not_enabled");
  }
  return gaps;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { textClass: text ? "non-json" : "empty" };
  }
}

function summarizeOpenAiError(body: unknown): Record<string, unknown> {
  const error = record(record(body).error);
  return {
    errorType: typeof error.type === "string" ? error.type : undefined,
    errorCode: typeof error.code === "string" ? error.code : undefined,
  };
}

function summarizeCloudflareEnvelope(body: unknown): Record<string, unknown> {
  const row = record(body);
  const errors = Array.isArray(row.errors) ? row.errors.map(record) : [];
  return {
    success: row.success === true,
    resultClass: Array.isArray(row.result) ? "array" : typeof row.result,
    errorCodes: errors
      .map((error) =>
        typeof error.code === "number" || typeof error.code === "string"
          ? error.code
          : undefined,
      )
      .filter((code) => code !== undefined),
  };
}

function modelIds(body: unknown): string[] {
  const data = record(body).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => record(item).id)
    .filter((id): id is string => typeof id === "string");
}

function choicesCount(body: unknown): number {
  const choices = record(body).choices;
  return Array.isArray(choices) ? choices.length : 0;
}

function embeddingsCount(body: unknown): number {
  const data = record(body).data;
  return Array.isArray(data) ? data.length : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg}`);
    }
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const key = camel(rawKey);
    if (inline !== undefined) {
      args[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args as CliArgs;
}

function camel(value: string): string {
  return value.replace(/-([a-z])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function optionalString(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

async function writeResult(
  result: CloudExtensionSmokeResult,
  options: CloudExtensionSmokeOptions,
): Promise<void> {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outFile) {
    await mkdir(dirname(options.outFile), { recursive: true });
    await Bun.write(options.outFile, json);
  }
  if (options.json) {
    console.log(json.trimEnd());
    return;
  }
  console.log(
    `${result.status === "passed" ? "✓" : "✗"} Cloud extension smoke ${result.status}; gaReady=${result.gaReady}; gaps=${result.gaps.join(",") || "none"}`,
  );
}

async function runSelfTest(): Promise<void> {
  const calls: { path: string; authorization?: string }[] = [];
  const options: CloudExtensionSmokeOptions = {
    url: "https://app.takosumi.test",
    sessionToken: "sess_super_secret_value",
    sessionTokenSource: "file",
    json: true,
    requireCompatMaterialization: false,
  };
  const result = await runCloudExtensionSmoke(options, async (url, init) => {
    const parsed = new URL(url);
    calls.push({
      path: parsed.pathname,
      authorization:
        typeof init?.headers === "object" && init.headers
          ? (init.headers as Record<string, string>).authorization
          : undefined,
    });
    if (parsed.pathname === "/v1/account/session/me") {
      return jsonResponse({ subject: "tsub_selftest" }, 200);
    }
    if (
      parsed.pathname === "/gateway/ai/v1/models" &&
      !authHeaderPresent(init)
    ) {
      return openAiResponse("unauthorized", 401);
    }
    if (parsed.pathname === "/gateway/ai/v1/models") {
      return jsonResponse({
        object: "list",
        data: [{ id: "takosumi/default", object: "model" }],
      });
    }
    if (parsed.pathname === "/gateway/ai/v1/chat/completions") {
      return jsonResponse({ choices: [{ index: 0 }] });
    }
    if (parsed.pathname === "/gateway/ai/v1/embeddings") {
      return jsonResponse({ data: [{ embedding: [0] }] });
    }
    if (
      parsed.pathname === "/compat/cloudflare/client/v4/user/tokens/verify" &&
      !authHeaderPresent(init)
    ) {
      return cloudflareResponse(false, null, 401, [10000]);
    }
    if (parsed.pathname === "/compat/cloudflare/client/v4/user/tokens/verify") {
      return cloudflareResponse(true, { status: "active" });
    }
    if (parsed.pathname === "/compat/cloudflare/client/v4/accounts") {
      return cloudflareResponse(true, [{ id: "ts_acc_takosumi_cloud" }]);
    }
    if (parsed.pathname.endsWith("/workers/scripts")) {
      return cloudflareResponse(true, []);
    }
    return cloudflareResponse(false, null, 501, [9001]);
  });
  if (result.status !== "passed") {
    throw new Error(
      "self-test expected pass when compat materialization is optional",
    );
  }
  if (result.gaReady) {
    throw new Error("self-test should report gaReady=false for compat stub");
  }
  const serialized = JSON.stringify(result);
  if (serialized.includes("sess_super_secret_value")) {
    throw new Error("self-test leaked session token in evidence result");
  }
  if (
    !calls.some(
      (call) => call.authorization === "Bearer sess_super_secret_value",
    )
  ) {
    throw new Error(
      "self-test did not send bearer token to authenticated routes",
    );
  }
  const strict = await runCloudExtensionSmoke(
    { ...options, requireCompatMaterialization: true },
    async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/workers/scripts/takosumi-smoke")) {
        return cloudflareResponse(false, null, 501, [9001]);
      }
      return jsonResponseForSelfTest(parsed, init);
    },
  );
  if (strict.status !== "failed" || strict.gaReady) {
    throw new Error("self-test strict mode should fail on compat stub");
  }
  console.log("cloud extension smoke self-test passed");
}

function authHeaderPresent(init: RequestInit | undefined): boolean {
  return (
    typeof init?.headers === "object" &&
    init.headers !== null &&
    typeof (init.headers as Record<string, string>).authorization === "string"
  );
}

function jsonResponseForSelfTest(
  url: URL,
  init: RequestInit | undefined,
): Response {
  if (url.pathname === "/v1/account/session/me") {
    return jsonResponse({ subject: "tsub_selftest" }, 200);
  }
  if (url.pathname === "/gateway/ai/v1/models" && !authHeaderPresent(init)) {
    return openAiResponse("unauthorized", 401);
  }
  if (url.pathname === "/gateway/ai/v1/models") {
    return jsonResponse({
      object: "list",
      data: [{ id: "takosumi/default", object: "model" }],
    });
  }
  if (url.pathname === "/gateway/ai/v1/chat/completions") {
    return jsonResponse({ choices: [{ index: 0 }] });
  }
  if (url.pathname === "/gateway/ai/v1/embeddings") {
    return jsonResponse({ data: [{ embedding: [0] }] });
  }
  if (
    url.pathname === "/compat/cloudflare/client/v4/user/tokens/verify" &&
    !authHeaderPresent(init)
  ) {
    return cloudflareResponse(false, null, 401, [10000]);
  }
  if (url.pathname === "/compat/cloudflare/client/v4/user/tokens/verify") {
    return cloudflareResponse(true, { status: "active" });
  }
  if (url.pathname === "/compat/cloudflare/client/v4/accounts") {
    return cloudflareResponse(true, [{ id: "ts_acc_takosumi_cloud" }]);
  }
  if (url.pathname.endsWith("/workers/scripts")) {
    return cloudflareResponse(true, []);
  }
  return cloudflareResponse(true, { id: "takosumi-smoke" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiResponse(code: string, status: number): Response {
  return jsonResponse(
    { error: { code, type: "invalid_request_error" } },
    status,
  );
}

function cloudflareResponse(
  success: boolean,
  result: unknown,
  status = 200,
  errorCodes: readonly (string | number)[] = [],
): Response {
  return jsonResponse(
    {
      success,
      result,
      errors: errorCodes.map((code) => ({ code, message: "redacted" })),
      messages: [],
    },
    status,
  );
}

function printHelp(): void {
  console.log(`Usage:
  bun run smoke:cloud-extensions -- --url <origin> --session-token-file <path>

Required inputs:
  --url <origin>                       or TAKOSUMI_PLATFORM_URL
  --session-token-file <path>          or TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE / TAKOSUMI_ACCOUNT_SESSION_TOKEN

Options:
  --out-file <path>                    write redacted JSON evidence to a private file
  --require-compat-materialization     fail if Cloudflare Workers script materialization still returns 501
  --platform-version <id>              include deployed platform version id in evidence
  --ai-gateway-version <id>            include deployed AI gateway worker version id in evidence
  --cloudflare-compat-version <id>     include deployed Cloudflare compat worker version id in evidence
  --json                               print JSON only
  --self-test                          run offline shape/redaction self-test
`);
}
