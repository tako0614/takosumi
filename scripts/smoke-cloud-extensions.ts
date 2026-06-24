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
import { TAKOSUMI_AI_GATEWAY_STATUS_PATH } from "../contract/ai-gateway.ts";

export const CLOUD_EXTENSION_SMOKE_KIND =
  "takosumi.cloud-extension-smoke@v1" as const;

const CLOUDFLARE_COMPAT_ACCOUNT_ID = "ts_acc_takosumi_cloud";
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT = "takosumi-smoke";
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT_PATH = `/compat/cloudflare/client/v4/accounts/${CLOUDFLARE_COMPAT_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_COMPAT_SMOKE_SCRIPT}`;
const CLOUDFLARE_COMPAT_SMOKE_SCRIPT_BODY =
  "export default { fetch() { return new Response('takosumi smoke'); } };";
const CLOUD_EXTENSION_CATALOG_PATH = "/__takosumi/cloud/extensions";
const REQUIRED_CLOUD_EXTENSION_IDS = [
  "ai.openai_compatible.v1",
  "provider.cloudflare.client_v4",
] as const;

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
  readonly requireAiUpstreamProfile: boolean;
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
  readonly requireAiUpstreamProfile: boolean;
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
  readonly requireAiUpstreamProfile?: boolean;
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
      : (args.sessionTokenFile ?? env.TAKOSUMI_ACCOUNT_SESSION_TOKEN_FILE);
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
      requireAiUpstreamProfile: args.requireAiUpstreamProfile === true,
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
    requireAiUpstreamProfile: args.requireAiUpstreamProfile === true,
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

interface CloudExtensionProviderResourceResult {
  readonly resource: string;
  readonly ok: boolean;
  readonly completedSteps: readonly string[];
  readonly summary: Record<string, unknown>;
  readonly errorClass?: string;
  readonly message?: string;
  readonly cleanup?: Record<string, unknown>;
}

export type CloudExtensionProviderE2ERunner = (
  options: CloudExtensionSmokeOptions,
) => Promise<CloudExtensionProviderE2EResult>;

export async function runCloudExtensionSmoke(
  options: CloudExtensionSmokeOptions,
  fetchImpl: FetchLike = fetch,
  providerE2eRunner: CloudExtensionProviderE2ERunner = runCloudflareCompatProviderE2E,
): Promise<CloudExtensionSmokeResult> {
  const authHeaders = {
    authorization: `Bearer ${options.sessionToken}`,
    accept: "application/json",
  };
  const checks: CloudExtensionSmokeCheck[] = [
    await authTokenCheck(fetchImpl, options, authHeaders),
    await requestCheck(fetchImpl, options, {
      name: "cloudExtensionCatalog",
      path: CLOUD_EXTENSION_CATALOG_PATH,
      expected:
        "platform Cloud extension catalog reports AI Gateway and Cloudflare compatibility as configured",
      pass: (response, body) =>
        response.status === 200 &&
        REQUIRED_CLOUD_EXTENSION_IDS.every((id) =>
          configuredCloudExtensionIds(body).includes(id),
        ),
      summarize: summarizeCloudExtensionCatalog,
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
  ];
  const aiGatewayStatus = await requestCheck(fetchImpl, options, {
    name: "aiGatewayStatus",
    path: TAKOSUMI_AI_GATEWAY_STATUS_PATH,
    expected: options.requireAiUpstreamProfile
      ? "authenticated AI Gateway status reports at least one configured upstream profile"
      : "authenticated AI Gateway status reports configured upstreams or the explicit Workers AI fallback",
    headers: authHeaders,
    pass: (response, body) => {
      if (response.status !== 200) return false;
      const mode = record(body).mode;
      if (options.requireAiUpstreamProfile) {
        return (
          mode === "configured_upstreams" &&
          positiveNumber(record(record(body).summary).profileCount)
        );
      }
      return mode === "configured_upstreams" || mode === "workers_ai_fallback";
    },
    summarize: summarizeAiGatewayStatus,
  });
  checks.push(aiGatewayStatus);
  const embeddingsModel = embeddingsModelFromAiGatewayStatus(
    aiGatewayStatus.summary,
  );
  checks.push(
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
  );
  checks.push(
    embeddingsModel
      ? await requestCheck(fetchImpl, options, {
          name: "aiEmbeddingsAuth",
          path: "/gateway/ai/v1/embeddings",
          method: "POST",
          expected:
            "authenticated OpenAI-compatible embeddings request succeeds with a configured embeddings-capable model",
          headers: { ...authHeaders, "content-type": "application/json" },
          body: { model: embeddingsModel, input: "takosumi" },
          pass: (response, body) =>
            response.status === 200 && embeddingsCount(body) > 0,
          summarize: (body) => ({
            embeddingCount: embeddingsCount(body),
            requestedModel: embeddingsModel,
            model:
              typeof record(body).model === "string"
                ? record(body).model
                : null,
          }),
        })
      : syntheticCheck({
          name: "aiEmbeddingsAuth",
          method: "POST",
          path: "/gateway/ai/v1/embeddings",
          expected:
            "authenticated OpenAI-compatible embeddings request succeeds with a configured embeddings-capable model",
          summary: {
            errorCode: "ai_gateway_embedding_model_not_configured",
          },
        }),
  );
  checks.push(
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
  );
  if (options.requireProviderE2E) {
    checks.push(
      await cloudflareCompatProviderE2ECheck(options, providerE2eRunner),
    );
  }
  const gaps = cloudExtensionGaps(checks);
  const gaReady = checks.every((check) => check.ok) && gaps.length === 0;
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
    requireAiUpstreamProfile: options.requireAiUpstreamProfile,
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

function syntheticCheck(input: {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly expected: string;
  readonly summary: Record<string, unknown>;
}): CloudExtensionSmokeCheck {
  return {
    name: input.name,
    method: input.method,
    path: input.path,
    status: 0,
    ok: false,
    expected: input.expected,
    summary: input.summary,
  };
}

function cloudExtensionGaps(
  checks: readonly CloudExtensionSmokeCheck[],
): string[] {
  const gaps: string[] = [];
  const catalog = checks.find(
    (check) => check.name === "cloudExtensionCatalog",
  );
  if (catalog && !catalog.ok) {
    gaps.push("cloud_extension_catalog_not_ready");
  }
  const aiStatus = checks.find((check) => check.name === "aiGatewayStatus");
  if (
    aiStatus &&
    aiStatus.ok &&
    aiStatus.summary.mode === "workers_ai_fallback"
  ) {
    gaps.push("ai_gateway_external_upstream_not_configured");
  }
  if (aiStatus && !aiStatus.ok) {
    gaps.push("ai_gateway_status_not_ready");
  }
  const aiEmbeddings = checks.find(
    (check) => check.name === "aiEmbeddingsAuth",
  );
  if (
    aiEmbeddings &&
    aiEmbeddings.summary.errorCode ===
      "ai_gateway_embedding_model_not_configured"
  ) {
    gaps.push("ai_gateway_embedding_model_not_configured");
  }
  const materialization = checks.find(
    (check) =>
      check.name === "cloudflareCompatScriptPutAuth" && check.status === 501,
  );
  if (materialization) {
    gaps.push("cloudflare_compat_materialization_not_enabled");
  }
  const providerE2E = checks.find(
    (check) => check.name === "cloudflareCompatProviderE2E",
  );
  if (providerE2E && !providerE2E.ok) {
    gaps.push("cloudflare_compat_provider_e2e_failed");
    for (const resource of providerE2EResources(providerE2E.summary)) {
      if (resource.resource === "cloudflare_workers_script" && !resource.ok) {
        gaps.push("cloudflare_compat_provider_workers_script_not_ready");
      }
    }
  }
  return gaps;
}

function providerE2EResources(
  summary: Record<string, unknown>,
): readonly CloudExtensionProviderResourceResult[] {
  const resources = summary.resources;
  if (!Array.isArray(resources)) return [];
  return resources
    .map((resource) => record(resource))
    .filter(
      (resource): resource is Record<string, unknown> & { resource: string } =>
        typeof resource.resource === "string",
    )
    .map((resource) => ({
      resource: resource.resource,
      ok: resource.ok === true,
      completedSteps: Array.isArray(resource.completedSteps)
        ? resource.completedSteps.filter(
            (step): step is string => typeof step === "string",
          )
        : [],
      summary: record(resource.summary),
      errorClass:
        typeof resource.errorClass === "string"
          ? resource.errorClass
          : undefined,
      message:
        typeof resource.message === "string" ? resource.message : undefined,
      cleanup: resource.cleanup ? record(resource.cleanup) : undefined,
    }));
}

async function runCloudflareCompatProviderE2E(
  options: CloudExtensionSmokeOptions,
): Promise<CloudExtensionProviderE2EResult> {
  const resources = [
    await runCloudflareCompatR2BucketProviderE2E(options),
    await runCloudflareCompatWorkersScriptProviderE2E(options),
  ];
  const failedResources = resources
    .filter((resource) => !resource.ok)
    .map((resource) => resource.resource);
  return {
    status: failedResources.length === 0 ? 200 : 500,
    ok: failedResources.length === 0,
    summary: {
      resources,
      completedResources: resources
        .filter((resource) => resource.ok)
        .map((resource) => resource.resource),
      failedResources,
    },
  };
}

async function runCloudflareCompatR2BucketProviderE2E(
  options: CloudExtensionSmokeOptions,
): Promise<CloudExtensionProviderResourceResult> {
  const workdir = await mkdtemp(
    join(tmpdir(), "takosumi-cloud-compat-provider-"),
  );
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
    await tofu(
      ["plan", "-input=false", "-no-color", "-out=tfplan"],
      workdir,
      env,
    );
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
      resource: "cloudflare_r2_bucket",
      ok: true,
      completedSteps,
      summary: {
        bucketName,
      },
    };
  } catch (error) {
    return {
      resource: "cloudflare_r2_bucket",
      ok: false,
      completedSteps,
      summary: {
        bucketName,
      },
      errorClass:
        error instanceof Error ? error.name || "Error" : typeof error,
      message: sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
      ),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function runCloudflareCompatWorkersScriptProviderE2E(
  options: CloudExtensionSmokeOptions,
): Promise<CloudExtensionProviderResourceResult> {
  const workdir = await mkdtemp(
    join(tmpdir(), "takosumi-cloud-compat-provider-"),
  );
  const scriptName = `takosumi-e2e-worker-${Date.now().toString(36)}`;
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

variable "script_name" {
  type = string
}

locals {
  worker_module = <<-EOT
    export default { async fetch() { return new Response('takosumi provider e2e'); } };
  EOT
}

resource "cloudflare_workers_script" "smoke" {
  account_id         = "${CLOUDFLARE_COMPAT_ACCOUNT_ID}"
  script_name        = var.script_name
  content            = local.worker_module
  main_module        = "index.js"
  compatibility_date = "2025-01-01"
}

output "script_name" {
  value = cloudflare_workers_script.smoke.script_name
}
`,
    );
    const env = {
      CLOUDFLARE_API_TOKEN: options.sessionToken,
      TF_VAR_script_name: scriptName,
      TF_IN_AUTOMATION: "1",
    };
    await tofu(["init", "-input=false", "-no-color"], workdir, env);
    completedSteps.push("init");
    await tofu(
      ["plan", "-input=false", "-no-color", "-out=tfplan"],
      workdir,
      env,
    );
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
      resource: "cloudflare_workers_script",
      ok: true,
      completedSteps,
      summary: { scriptName },
    };
  } catch (error) {
    const cleanup = completedSteps.includes("apply")
      ? await cleanupCloudflareCompatWorkerScript(options, scriptName)
      : undefined;
    return {
      resource: "cloudflare_workers_script",
      ok: false,
      completedSteps,
      summary: { scriptName },
      errorClass:
        error instanceof Error ? error.name || "Error" : typeof error,
      message: sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
      ),
      cleanup,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function cleanupCloudflareCompatWorkerScript(
  options: CloudExtensionSmokeOptions,
  scriptName: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(
      `${options.url}/compat/cloudflare/client/v4/accounts/${CLOUDFLARE_COMPAT_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(scriptName)}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${options.sessionToken}`,
          accept: "application/json",
        },
      },
    );
    const body = await readJson(response);
    return {
      attempted: true,
      status: response.status,
      ok: response.ok && record(body).success === true,
      summary: summarizeCloudflareEnvelope(body),
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      errorClass:
        error instanceof Error ? error.name || "Error" : typeof error,
      message: sanitizeErrorMessage(
        error instanceof Error ? error.message : String(error),
      ),
    };
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

function summarizeCloudExtensionCatalog(
  body: unknown,
): Record<string, unknown> {
  const extensions = cloudExtensionCatalogItems(body);
  const configuredIds = configuredCloudExtensionIds(body);
  return {
    kind: record(body).kind,
    ids: extensions
      .map((extension) => record(extension).id)
      .filter((id): id is string => typeof id === "string"),
    configuredIds,
    missingRequiredIds: REQUIRED_CLOUD_EXTENSION_IDS.filter(
      (id) => !configuredIds.includes(id),
    ),
  };
}

function summarizeAiGatewayStatus(body: unknown): Record<string, unknown> {
  const row = record(body);
  const summary = record(row.summary);
  const embeddingModels = aiGatewayEmbeddingModels(row);
  return {
    kind: row.kind,
    mode: typeof row.mode === "string" ? row.mode : undefined,
    defaultModel:
      typeof row.defaultModel === "string" ? row.defaultModel : undefined,
    profileCount:
      typeof summary.profileCount === "number" ? summary.profileCount : 0,
    publicModelCount:
      typeof summary.publicModelCount === "number"
        ? summary.publicModelCount
        : 0,
    providers: Array.isArray(summary.providers)
      ? summary.providers.filter(
          (provider): provider is string => typeof provider === "string",
        )
      : [],
    embeddingModels,
  };
}

function embeddingsModelFromAiGatewayStatus(
  summary: Record<string, unknown>,
): string | null {
  const models = summary.embeddingModels;
  if (!Array.isArray(models)) return null;
  return models.find((model): model is string => typeof model === "string") ??
    null;
}

function aiGatewayEmbeddingModels(
  row: Record<string, unknown>,
): readonly string[] {
  const models = new Set<string>();
  const profiles = row.upstreamProfiles;
  if (Array.isArray(profiles)) {
    for (const profile of profiles) {
      const publicModels = record(profile).publicModels;
      if (!Array.isArray(publicModels)) continue;
      for (const publicModel of publicModels) {
        const item = record(publicModel);
        const endpoints = item.endpoints;
        if (
          Array.isArray(endpoints) &&
          endpoints.includes("embeddings") &&
          typeof item.publicModel === "string"
        ) {
          models.add(item.publicModel);
        }
      }
    }
  }
  const fallback = record(row.workersAiFallback);
  if (
    fallback.enabled !== false &&
    typeof fallback.embeddingModel === "string"
  ) {
    models.add(fallback.embeddingModel);
  }
  return [...models];
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function configuredCloudExtensionIds(body: unknown): string[] {
  return cloudExtensionCatalogItems(body)
    .filter((extension) => record(extension).configured === true)
    .map((extension) => record(extension).id)
    .filter((id): id is string => typeof id === "string");
}

function cloudExtensionCatalogItems(body: unknown): unknown[] {
  const extensions = record(body).extensions;
  return Array.isArray(extensions) ? extensions : [];
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

function authTokenKindValue(
  value: string | undefined,
): AuthTokenKind | undefined {
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
    requireAiUpstreamProfile: false,
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
    if (parsed.pathname === CLOUD_EXTENSION_CATALOG_PATH) {
      return cloudExtensionCatalogResponse(true);
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
    if (parsed.pathname === TAKOSUMI_AI_GATEWAY_STATUS_PATH) {
      return aiGatewayStatusResponse("workers_ai_fallback");
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
  if (url.pathname === CLOUD_EXTENSION_CATALOG_PATH) {
    return cloudExtensionCatalogResponse(true);
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
  if (url.pathname === TAKOSUMI_AI_GATEWAY_STATUS_PATH) {
    return aiGatewayStatusResponse("workers_ai_fallback");
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

function cloudExtensionCatalogResponse(configured: boolean): Response {
  return jsonResponse({
    kind: "takosumi.platform-cloud-extensions@v1",
    extensions: REQUIRED_CLOUD_EXTENSION_IDS.map((id) => ({
      id,
      configured,
    })),
  });
}

function aiGatewayStatusResponse(
  mode: "configured_upstreams" | "workers_ai_fallback",
): Response {
  const embeddingModel = "workers-ai/bge-base-en-v1.5";
  return jsonResponse({
    kind: "takosumi.ai-gateway-status@v1",
    mode,
    defaultModel: "takosumi/default",
    summary: {
      profileCount: mode === "configured_upstreams" ? 1 : 0,
      publicModelCount: mode === "configured_upstreams" ? 1 : 3,
      providers:
        mode === "configured_upstreams" ? ["deepseek"] : ["workers_ai"],
    },
    upstreamProfiles:
      mode === "configured_upstreams"
        ? [
            {
              id: "deepseek-main",
              provider: "deepseek",
              endpointOrigin: "https://api.deepseek.example",
              modelCount: 2,
              publicModels: [
                {
                  publicModel: "takosumi/default",
                  endpoints: ["chat.completions"],
                  default: true,
                },
                {
                  publicModel: "deepseek/text-embedding-v3",
                  endpoints: ["embeddings"],
                },
              ],
            },
          ]
        : [],
    workersAiFallback: {
      enabled: true,
      aiBindingConfigured: true,
      chatModel: "@cf/meta/llama-3.1-8b-instruct",
      embeddingModel,
    },
  });
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
  --require-ai-upstream-profile        fail when AI Gateway only has the Workers AI fallback configured
  --platform-version <id>              include deployed platform version id in evidence
  --ai-gateway-version <id>            include deployed AI gateway worker version id in evidence
  --cloudflare-compat-version <id>     include deployed Cloudflare compat worker version id in evidence
  --json                               print JSON only
  --self-test                          run offline shape/redaction self-test
`);
}
