#!/usr/bin/env bun
/**
 * Takosumi Cloud-only extension smoke.
 *
 * This verifies the hosted platform worker's Cloud-only service-binding seam
 * and the closed extension workers mounted behind it. It intentionally stores
 * only redacted response summaries: no session token, cookie, bearer, or token
 * file path is written to the evidence JSON.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

export const CLOUD_EXTENSION_SMOKE_KIND =
  "takosumi.cloud-extension-smoke@v1" as const;

const CLOUDFLARE_COMPAT_ACCOUNT_ID = "ts_acc_takosumi_cloud";
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT = "takosumi-smoke";
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT_PATH = `/compat/cloudflare/client/v4/accounts/${CLOUDFLARE_COMPAT_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_COMPAT_SMOKE_SCRIPT}`;
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT_BODY =
  "export default { fetch() { return new Response('takosumi smoke'); } };";

type FetchLike = typeof fetch;
type AuthTokenKind = "session" | "pat";

export interface CloudExtensionSmokeOptions {
  readonly url: string;
  readonly sessionToken: string;
  readonly authTokenKind: AuthTokenKind;
  readonly sessionTokenSource: "env" | "file";
  readonly outFile?: string;
  readonly json: boolean;
  readonly requireCompatMaterialization: boolean;
  readonly requireProviderE2E: boolean;
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
  readonly authTokenKind: AuthTokenKind;
  readonly sessionTokenSource: "env" | "file";
  readonly requireCompatMaterialization: boolean;
  readonly requireProviderE2E: boolean;
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
  readonly requireProviderE2e?: boolean;
  readonly platformVersion?: string;
  readonly aiGatewayVersion?: string;
  readonly cloudflareCompatVersion?: string;
  readonly authTokenKind?: string;
  readonly patTokenFile?: string;
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
  const explicitKind = authTokenKindValue(args.authTokenKind);
  const patTokenFile =
    args.patTokenFile ?? env.TAKOSUMI_CLOUD_EXTENSION_PAT_FILE;
  const patToken = env.TAKOSUMI_CLOUD_EXTENSION_PAT?.trim();
  const authTokenKind =
    explicitKind ?? (patTokenFile || patToken ? "pat" : "session");
  const tokenFile =
    authTokenKind === "pat"
      ? patTokenFile
      : args.sessionTokenFile ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE;
  if (tokenFile) {
    const sessionToken = (await Bun.file(tokenFile).text()).trim();
    if (!sessionToken) throw new Error("auth token file is empty");
    return {
      url: normalizeBaseUrl(url),
      sessionToken,
      authTokenKind,
      sessionTokenSource: "file",
      outFile: args.outFile,
      json: args.json === true,
      requireCompatMaterialization: args.requireCompatMaterialization === true,
      requireProviderE2E:
        args.requireProviderE2E === true || args.requireProviderE2e === true,
      platformVersion: optionalString(args.platformVersion),
      aiGatewayVersion: optionalString(args.aiGatewayVersion),
      cloudflareCompatVersion: optionalString(args.cloudflareCompatVersion),
    };
  }
  const sessionToken =
    authTokenKind === "pat"
      ? patToken
      : env.TAKOSUMI_ACCOUNT_SESSION_TOKEN?.trim();
  if (!sessionToken) {
    throw new Error(
      "--session-token-file, --pat-token-file, TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE, TAKOSUMI_ACCOUNT_SESSION_TOKEN, TAKOSUMI_CLOUD_EXTENSION_PAT_FILE, or TAKOSUMI_CLOUD_EXTENSION_PAT is required",
    );
  }
  return {
    url: normalizeBaseUrl(url),
    sessionToken,
    authTokenKind,
    sessionTokenSource: "env",
    outFile: args.outFile,
    json: args.json === true,
    requireCompatMaterialization: args.requireCompatMaterialization === true,
    requireProviderE2E:
      args.requireProviderE2E === true || args.requireProviderE2e === true,
    platformVersion: optionalString(args.platformVersion),
    aiGatewayVersion: optionalString(args.aiGatewayVersion),
    cloudflareCompatVersion: optionalString(args.cloudflareCompatVersion),
  };
}

export interface CloudExtensionProviderE2EResult {
  readonly status: number;
  readonly ok: boolean;
  readonly summary: Record<string, unknown>;
}

export type CloudExtensionProviderE2ERunner = (
  options: CloudExtensionSmokeOptions,
) => Promise<CloudExtensionProviderE2EResult>;

export async function runCloudExtensionSmoke(
  options: CloudExtensionSmokeOptions,
  fetchImpl: FetchLike = fetch,
  providerE2eRunner: CloudExtensionProviderE2ERunner =
    runCloudflareCompatProviderE2E,
): Promise<CloudExtensionSmokeResult> {
  const authHeaders = {
    authorization: `Bearer ${options.sessionToken}`,
    accept: "application/json",
  };
  const checks: CloudExtensionSmokeCheck[] = [
    await authTokenCheck(fetchImpl, options, authHeaders),
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
  if (options.requireProviderE2E) {
    checks.push(await cloudflareCompatProviderE2ECheck(options, providerE2eRunner));
  }
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
    authTokenKind: options.authTokenKind,
    sessionTokenSource: options.sessionTokenSource,
    requireCompatMaterialization: options.requireCompatMaterialization,
    requireProviderE2E: options.requireProviderE2E,
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
      "Authenticated smoke uses a Takosumi account session or personal access token only for request headers; evidence stores status codes and redacted response summaries, never bearer/cookie/session/token material.",
  };
}

async function authTokenCheck(
  fetchImpl: FetchLike,
  options: CloudExtensionSmokeOptions,
  authHeaders: Record<string, string>,
): Promise<CloudExtensionSmokeCheck> {
  if (options.authTokenKind === "pat") {
    return await requestCheck(fetchImpl, options, {
      name: "cloudExtensionPatAuth",
      path: "/compat/cloudflare/client/v4/user/tokens/verify",
      expected:
        "authenticated PAT can enter the Cloud-only provider compatibility seam",
      headers: authHeaders,
      pass: (response, body) =>
        response.status === 200 && record(body).success === true,
      summarize: summarizeCloudflareEnvelope,
    });
  }
  return await requestCheck(fetchImpl, options, {
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
  });
}

async function cloudflareCompatProviderE2ECheck(
  options: CloudExtensionSmokeOptions,
  runner: CloudExtensionProviderE2ERunner,
): Promise<CloudExtensionSmokeCheck> {
  try {
    const result = await runner(options);
    return {
      name: "cloudflareCompatProviderE2E",
      method: "TOFU",
      path: "/compat/cloudflare/client/v4",
      status: result.status,
      ok: result.ok,
      expected:
        "Cloudflare Terraform/OpenTofu provider can plan, apply, and destroy through the compatibility endpoint",
      summary: result.summary,
    };
  } catch (error) {
    return {
      name: "cloudflareCompatProviderE2E",
      method: "TOFU",
      path: "/compat/cloudflare/client/v4",
      status: 500,
      ok: false,
      expected:
        "Cloudflare Terraform/OpenTofu provider can plan, apply, and destroy through the compatibility endpoint",
      summary: {
        errorClass:
          error instanceof Error ? error.name || "Error" : typeof error,
        message: sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      },
    };
  }
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

async function runCloudflareCompatProviderE2E(
  options: CloudExtensionSmokeOptions,
): Promise<CloudExtensionProviderE2EResult> {
  const workdir = await mkdtemp(join(tmpdir(), "takosumi-cloud-compat-provider-"));
  const bucketName = `takosumi-e2e-${Date.now().toString(36)}`;
  const completedSteps: string[] = [];
  try {
    await writeFile(
      join(workdir, "main.tf"),
      `terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

provider "cloudflare" {
  base_url = "${options.url}/compat/cloudflare/client/v4"
}

variable "bucket_name" {
  type = string
}

resource "cloudflare_r2_bucket" "smoke" {
  account_id = "${CLOUDFLARE_COMPAT_ACCOUNT_ID}"
  name       = var.bucket_name
}

output "bucket_name" {
  value = cloudflare_r2_bucket.smoke.name
}
`,
    );
    const env = {
      CLOUDFLARE_API_TOKEN: options.sessionToken,
      TF_VAR_bucket_name: bucketName,
      TF_IN_AUTOMATION: "1",
    };
    await tofu(["init", "-input=false", "-no-color"], workdir, env);
    completedSteps.push("init");
    await tofu(["plan", "-input=false", "-no-color", "-out=tfplan"], workdir, env);
    completedSteps.push("plan");
    await tofu(
      ["apply", "-input=false", "-no-color", "-auto-approve", "tfplan"],
      workdir,
      env,
    );
    completedSteps.push("apply");
    await tofu(
      ["destroy", "-input=false", "-no-color", "-auto-approve"],
      workdir,
      env,
    );
    completedSteps.push("destroy");
    return {
      status: 200,
      ok: true,
      summary: {
        resource: "cloudflare_r2_bucket",
        bucketName,
        completedSteps,
      },
    };
  } catch (error) {
    return {
      status: 500,
      ok: false,
      summary: {
        resource: "cloudflare_r2_bucket",
        bucketName,
        completedSteps,
        errorClass: error instanceof Error ? error.name || "Error" : typeof error,
        message: sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
      },
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function tofu(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(["tofu", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const output = sanitizeErrorMessage(`${stdout}\n${stderr}`.trim());
    throw new Error(`tofu ${args[0]} exited ${code}: ${output.slice(0, 800)}`);
  }
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

function authTokenKindValue(value: string | undefined): AuthTokenKind | undefined {
  if (value === undefined) return undefined;
  if (value === "session" || value === "pat") return value;
  throw new Error("--auth-token-kind must be session or pat");
}

function sanitizeErrorMessage(value: string): string {
  return value
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replaceAll(/takpat_[A-Za-z0-9._~+/=-]+/g, "takpat_<redacted>")
    .replaceAll(/token=[^&\s]+/g, "token=<redacted>")
    .replaceAll(/client_secret=[^&\s]+/g, "client_secret=<redacted>");
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
    authTokenKind: "session",
    sessionTokenSource: "file",
    json: true,
    requireCompatMaterialization: false,
    requireProviderE2E: false,
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
  --pat-token-file <path>              or TAKOSUMI_CLOUD_EXTENSION_PAT_FILE / TAKOSUMI_CLOUD_EXTENSION_PAT

Options:
  --auth-token-kind <session|pat>       force token interpretation when using env token inputs
  --out-file <path>                    write redacted JSON evidence to a private file
  --require-compat-materialization     fail if Cloudflare Workers script materialization still returns 501
  --require-provider-e2e               run tofu init/plan/apply/destroy through the Cloudflare compat endpoint
  --platform-version <id>              include deployed platform version id in evidence
  --ai-gateway-version <id>            include deployed AI gateway worker version id in evidence
  --cloudflare-compat-version <id>     include deployed Cloudflare compat worker version id in evidence
  --json                               print JSON only
  --self-test                          run offline shape/redaction self-test
`);
}
