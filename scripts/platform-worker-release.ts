import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WRANGLER = resolve(ROOT, "node_modules/.bin/wrangler");
const MAX_OUTPUT = 64 * 1024 * 1024;
// Dashboard bundling can legitimately exceed three minutes on the production
// operator host while the portable suite and Wrangler share the same filesystem.
// Keep the release bounded, but do not turn a slow, otherwise successful build
// into an opaque pre-mutation refusal.
const COMMAND_TIMEOUT_MS = 600_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/u;
const REQUIRED_BINDINGS = [
  "ASSETS",
  "TAKOSUMI_ACCOUNTS_DB",
  "TAKOSUMI_CONTROL_DB",
  "HOSTED",
  "TAKOSUMI_VERSION_METADATA",
] as const;

export type PlatformEnvironment = "staging" | "production";

const TARGETS = {
  staging: {
    origin: "https://app-staging.takosumi.com",
    workerName: "takosumi-staging",
    hostedService: "takosumi-hosted-staging",
  },
  production: {
    origin: "https://app.takosumi.com",
    workerName: "takosumi",
    hostedService: "takosumi-hosted",
  },
} as const satisfies Record<
  PlatformEnvironment,
  {
    readonly origin: string;
    readonly workerName: string;
    readonly hostedService: string;
  }
>;

const DASHBOARD_STORE_ORIGINS = {
  staging: "https://store-staging.takosumi.com",
  production: "https://store.takosumi.com",
} as const satisfies Record<PlatformEnvironment, string>;

export function platformTargetForEnvironment(environment: PlatformEnvironment) {
  return TARGETS[environment];
}

/**
 * Official hosted builds pin one environment-matched discovery Store. The OSS
 * dashboard build remains neutral when it is invoked outside this owner
 * release path, and users may still add other TCS servers at runtime.
 */
export function platformDashboardBuildEnvironment(
  environment: PlatformEnvironment,
): Record<string, string> {
  return {
    ...childEnvironment(),
    VITE_TAKOSUMI_TCS_STORE_URL: DASHBOARD_STORE_ORIGINS[environment],
  };
}

interface PlatformReleasePlan {
  readonly kind: "takosumi.platform-worker-release-plan@v2";
  readonly createdAt: string;
  readonly environment: PlatformEnvironment;
  readonly sourceCommit: string;
  readonly configPath: string;
  readonly configSha256: string;
  readonly dashboardIndexSha256: string;
  readonly secretNamesSha256: string;
  readonly predecessorVersionId: string;
  readonly confirmation: string;
}

type Options =
  | {
      readonly action: "plan";
      readonly config: string;
      readonly planOut: string;
    }
  | {
      readonly action: "execute";
      readonly plan: string;
      readonly confirmation: string;
      readonly reviewer: string;
      readonly evidence: string;
    }
  | {
      readonly action: "recover";
      readonly plan: string;
      readonly confirmation: string;
      readonly reviewer: string;
      readonly evidence: string;
    };

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runPlatformWorkerRelease(
  argv: readonly string[],
  environment: PlatformEnvironment = "staging",
): Promise<void> {
  const options = parsePlatformWorkerReleaseArgs(argv);
  if (options.action === "plan") await plan(options, environment);
  else if (options.action === "execute") await execute(options, environment);
  else await recover(options, environment);
}

export function parsePlatformWorkerReleaseArgs(
  argv: readonly string[],
): Options {
  const [action, ...rest] = argv;
  if (action !== "plan" && action !== "execute" && action !== "recover") {
    throw new Error("platform_worker_release_action_invalid");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("platform_worker_release_arguments_invalid");
    }
    if (values.has(key))
      throw new Error("platform_worker_release_argument_duplicate");
    values.set(key, value);
  }
  const allowed =
    action === "plan"
      ? ["--config", "--plan-out"]
      : ["--plan", "--confirm", "--review", "--evidence"];
  if (
    values.size !== allowed.length ||
    allowed.some((key) => !values.has(key)) ||
    [...values.keys()].some((key) => !allowed.includes(key))
  ) {
    throw new Error("platform_worker_release_arguments_invalid");
  }
  if (action === "plan") {
    return {
      action,
      config: absolute(values.get("--config")!),
      planOut: absolute(values.get("--plan-out")!),
    };
  }
  const common = {
    plan: absolute(values.get("--plan")!),
    confirmation: values.get("--confirm")!,
    reviewer: values.get("--review")!,
    evidence: absolute(values.get("--evidence")!),
  };
  return action === "execute"
    ? { ...common, action: "execute" }
    : { ...common, action: "recover" };
}

async function plan(
  options: Extract<Options, { action: "plan" }>,
  environment: PlatformEnvironment,
): Promise<void> {
  assertCleanAndPushed();
  assertReadableConfig(options.config);
  assertExternalAbsent(options.planOut);
  const config = readFileSync(options.config);
  assertConfigTargetsSource(
    new TextDecoder("utf-8", { fatal: true }).decode(config),
    options.config,
    environment,
  );
  const secrets = await readSecretNames(options.config);

  await requiredCommand(
    ["bun", "run", "build"],
    undefined,
    resolve(ROOT, "dashboard"),
    platformDashboardBuildEnvironment(environment),
  );
  const dashboardIndex = readFileSync(
    resolve(ROOT, "dashboard/dist/index.html"),
  );
  const predecessorVersionId = await readServingVersion(options.config);
  await requiredCommand([
    WRANGLER,
    "deploy",
    "--dry-run",
    "--config",
    options.config,
  ]);

  const subject = {
    kind: "takosumi.platform-worker-release-plan@v2" as const,
    createdAt: new Date().toISOString(),
    environment,
    sourceCommit: git(["rev-parse", "HEAD"]).trim(),
    configPath: options.config,
    configSha256: digest(config),
    dashboardIndexSha256: digest(dashboardIndex),
    secretNamesSha256: digest(
      new TextEncoder().encode(JSON.stringify(secrets)),
    ),
    predecessorVersionId,
  };
  const releasePlan: PlatformReleasePlan = {
    ...subject,
    confirmation: digest(new TextEncoder().encode(JSON.stringify(subject))),
  };
  writePrivate(
    options.planOut,
    new TextEncoder().encode(`${JSON.stringify(releasePlan, null, 2)}\n`),
  );
  process.stdout.write(
    `${JSON.stringify({ kind: releasePlan.kind, status: "planned", confirmation: releasePlan.confirmation, predecessorVersionId })}\n`,
  );
}

async function execute(
  options: Extract<Options, { action: "execute" }>,
  environment: PlatformEnvironment,
): Promise<void> {
  assertCleanAndPushed();
  assertPrivateFile(options.plan);
  assertExternalAbsent(options.evidence);
  if (!/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(options.reviewer)) {
    throw new Error("platform_worker_release_reviewer_invalid");
  }
  const plan = parsePlan(
    readFileSync(options.plan),
    options.confirmation,
    environment,
  );
  if (git(["rev-parse", "HEAD"]).trim() !== plan.sourceCommit) {
    throw new Error("platform_worker_release_source_drift");
  }
  assertReadableConfig(plan.configPath);
  const config = readFileSync(plan.configPath);
  assertConfigTargetsSource(
    new TextDecoder("utf-8", { fatal: true }).decode(config),
    plan.configPath,
    plan.environment,
  );
  if (digest(config) !== plan.configSha256) {
    throw new Error("platform_worker_release_config_drift");
  }
  await assertSecretNamesUnchanged(plan.configPath, plan.secretNamesSha256);
  if (
    digest(readFileSync(resolve(ROOT, "dashboard/dist/index.html"))) !==
    plan.dashboardIndexSha256
  ) {
    throw new Error("platform_worker_release_dashboard_drift");
  }
  if (
    (await readServingVersion(plan.configPath)) !== plan.predecessorVersionId
  ) {
    throw new Error("platform_worker_release_predecessor_drift");
  }

  let mutationStarted = false;
  try {
    mutationStarted = true;
    await requiredCommand([WRANGLER, "deploy", "--config", plan.configPath]);
    const deployedVersionId = await waitForServingVersion(
      plan.configPath,
      plan.predecessorVersionId,
    );
    await verifyPublishedVersion(plan.configPath, deployedVersionId);
    await verifyPublicReadback(plan.environment, deployedVersionId);
    const evidence = {
      kind: "takosumi.platform-worker-release-evidence@v1",
      status: "ready",
      completedAt: new Date().toISOString(),
      environment: plan.environment,
      sourceCommit: plan.sourceCommit,
      configSha256: plan.configSha256,
      dashboardIndexSha256: plan.dashboardIndexSha256,
      predecessorVersionId: plan.predecessorVersionId,
      deployedVersionId,
      planConfirmation: plan.confirmation,
      reviewer: options.reviewer,
      reversal: `wrangler versions deploy ${plan.predecessorVersionId}@100% --config ${plan.configPath}`,
    };
    writePrivate(
      options.evidence,
      new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
    );
    process.stdout.write(
      `${JSON.stringify({ kind: evidence.kind, status: evidence.status, deployedVersionId, evidence: options.evidence })}\n`,
    );
  } catch {
    writePrivate(
      options.evidence,
      new TextEncoder().encode(
        `${JSON.stringify(
          {
            kind: "takosumi.platform-worker-release-evidence@v1",
            status: mutationStarted ? "indeterminate" : "failed",
            sourceCommit: plan.sourceCommit,
            planConfirmation: plan.confirmation,
            predecessorVersionId: plan.predecessorVersionId,
            failureCode: "platform_worker_release_failed",
          },
          null,
          2,
        )}\n`,
      ),
    );
    throw new Error("platform_worker_release_failed");
  }
}

async function recover(
  options: Extract<Options, { action: "recover" }>,
  environment: PlatformEnvironment,
): Promise<void> {
  assertCleanAndPushed();
  assertPrivateFile(options.plan);
  assertExternalAbsent(options.evidence);
  if (!/^operator:[A-Za-z0-9._@-]{3,128}$/u.test(options.reviewer)) {
    throw new Error("platform_worker_release_reviewer_invalid");
  }
  const plan = parsePlan(
    readFileSync(options.plan),
    options.confirmation,
    environment,
  );
  const head = git(["rev-parse", "HEAD"]).trim();
  if (!isAncestor(plan.sourceCommit, head)) {
    throw new Error("platform_worker_release_recovery_source_invalid");
  }
  assertReadableConfig(plan.configPath);
  const config = readFileSync(plan.configPath);
  if (digest(config) !== plan.configSha256) {
    throw new Error("platform_worker_release_config_drift");
  }
  await assertSecretNamesUnchanged(plan.configPath, plan.secretNamesSha256);
  if (
    digest(readFileSync(resolve(ROOT, "dashboard/dist/index.html"))) !==
    plan.dashboardIndexSha256
  ) {
    throw new Error("platform_worker_release_dashboard_drift");
  }
  const deployedVersionId = await readServingVersion(plan.configPath);
  if (deployedVersionId === plan.predecessorVersionId) {
    throw new Error("platform_worker_release_recovery_not_published");
  }
  const versions = await requiredCommand([
    WRANGLER,
    "versions",
    "list",
    "--config",
    plan.configPath,
    "--json",
  ]);
  if (
    selectRecoveredVersion(versions.stdout, plan.createdAt) !==
    deployedVersionId
  ) {
    throw new Error("platform_worker_release_recovery_version_invalid");
  }
  await verifyPublishedVersion(plan.configPath, deployedVersionId);
  await verifyPublicReadback(plan.environment, deployedVersionId);
  const evidence = {
    kind: "takosumi.platform-worker-release-evidence@v1",
    status: "ready",
    completedAt: new Date().toISOString(),
    environment: plan.environment,
    sourceCommit: plan.sourceCommit,
    recoverySourceCommit: head,
    configSha256: plan.configSha256,
    dashboardIndexSha256: plan.dashboardIndexSha256,
    predecessorVersionId: plan.predecessorVersionId,
    deployedVersionId,
    planConfirmation: plan.confirmation,
    reviewer: options.reviewer,
    lostAcknowledgement: true,
    reversal: `wrangler versions deploy ${plan.predecessorVersionId}@100% --config ${plan.configPath}`,
  };
  writePrivate(
    options.evidence,
    new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`),
  );
  process.stdout.write(
    `${JSON.stringify({ kind: evidence.kind, status: evidence.status, deployedVersionId, lostAcknowledgement: true, evidence: options.evidence })}\n`,
  );
}

function parsePlan(
  bytes: Uint8Array,
  confirmation: string,
  environment: PlatformEnvironment,
): PlatformReleasePlan {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown;
  if (!record(value)) throw new Error("platform_worker_release_plan_invalid");
  const { confirmation: recorded, ...subject } = value;
  if (
    value.kind !== "takosumi.platform-worker-release-plan@v2" ||
    value.environment !== environment ||
    typeof value.sourceCommit !== "string" ||
    !COMMIT.test(value.sourceCommit) ||
    typeof value.configPath !== "string" ||
    !isAbsolute(value.configPath) ||
    typeof value.configSha256 !== "string" ||
    !SHA256.test(value.configSha256) ||
    typeof value.dashboardIndexSha256 !== "string" ||
    !SHA256.test(value.dashboardIndexSha256) ||
    typeof value.secretNamesSha256 !== "string" ||
    !SHA256.test(value.secretNamesSha256) ||
    typeof value.predecessorVersionId !== "string" ||
    !VERSION.test(value.predecessorVersionId) ||
    typeof recorded !== "string" ||
    !SHA256.test(recorded) ||
    confirmation !== recorded ||
    digest(new TextEncoder().encode(JSON.stringify(subject))) !== recorded
  ) {
    throw new Error("platform_worker_release_plan_invalid");
  }
  return value as unknown as PlatformReleasePlan;
}

export function parseServingVersion(stdout: string): string {
  const value = JSON.parse(stdout) as unknown;
  const ids = new Set<string>();
  visit(value, (entry) => {
    const id = entry.version_id ?? entry.versionId;
    if (entry.percentage === 100 && typeof id === "string" && VERSION.test(id))
      ids.add(id);
  });
  if (ids.size !== 1)
    throw new Error("platform_worker_release_serving_version_invalid");
  return [...ids][0]!;
}

export function selectRecoveredVersion(
  stdout: string,
  planCreatedAt: string,
): string {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || !Number.isFinite(Date.parse(planCreatedAt))) {
    throw new Error("platform_worker_release_versions_invalid");
  }
  const ids = value.flatMap((entry) => {
    if (!record(entry))
      throw new Error("platform_worker_release_versions_invalid");
    const metadata = entry.metadata;
    if (!record(metadata)) return [];
    const id = entry.id;
    const createdOn = metadata.created_on;
    if (
      typeof id !== "string" ||
      !VERSION.test(id) ||
      typeof createdOn !== "string" ||
      !Number.isFinite(Date.parse(createdOn))
    ) {
      throw new Error("platform_worker_release_versions_invalid");
    }
    return Date.parse(createdOn) >= Date.parse(planCreatedAt) ? [id] : [];
  });
  if (ids.length !== 1) {
    throw new Error("platform_worker_release_recovery_version_ambiguous");
  }
  return ids[0]!;
}

export function bindingNames(stdout: string): readonly string[] {
  const value = JSON.parse(stdout) as unknown;
  if (
    !record(value) ||
    !record(value.resources) ||
    !Array.isArray(value.resources.bindings)
  ) {
    throw new Error("platform_worker_release_version_invalid");
  }
  const names = new Set<string>();
  for (const binding of value.resources.bindings) {
    if (!record(binding))
      throw new Error("platform_worker_release_version_invalid");
    for (const key of ["name", "binding"] as const) {
      const candidate = binding[key];
      if (typeof candidate === "string") names.add(candidate);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function secretNames(stdout: string): readonly string[] {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("platform_worker_release_secret_list_invalid");
  }
  const names = value.map((entry) => {
    if (!record(entry) || typeof entry.name !== "string") {
      throw new Error("platform_worker_release_secret_list_invalid");
    }
    if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(entry.name)) {
      throw new Error("platform_worker_release_secret_list_invalid");
    }
    return entry.name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("platform_worker_release_secret_list_invalid");
  }
  return names.sort((left, right) => left.localeCompare(right));
}

export function assertPublishedVersion(
  stdout: string,
  expectedHostedService: string,
): void {
  const value = JSON.parse(stdout) as unknown;
  if (
    !record(value) ||
    !record(value.resources) ||
    !record(value.resources.script) ||
    !Array.isArray(value.resources.script.handlers) ||
    !Array.isArray(value.resources.bindings) ||
    value.resources.script.handlers.some(
      (handler) => typeof handler !== "string",
    )
  ) {
    throw new Error("platform_worker_release_version_invalid");
  }
  const bindings = value.resources.bindings;
  for (const required of REQUIRED_BINDINGS) {
    const matches = bindings.filter(
      (binding) =>
        record(binding) &&
        (binding.name === required || binding.binding === required),
    );
    const expectedType = {
      ASSETS: "assets",
      TAKOSUMI_ACCOUNTS_DB: "d1",
      TAKOSUMI_CONTROL_DB: "d1",
      HOSTED: "service",
      TAKOSUMI_VERSION_METADATA: "version_metadata",
    }[required];
    if (
      matches.length !== 1 ||
      !record(matches[0]) ||
      matches[0].type !== expectedType ||
      (required === "HOSTED" && matches[0].service !== expectedHostedService)
    ) {
      throw new Error("platform_worker_release_binding_invalid");
    }
  }
  const rawNamedHandlers = value.resources.script.named_handlers;
  if (rawNamedHandlers !== undefined && !Array.isArray(rawNamedHandlers)) {
    throw new Error("platform_worker_release_version_invalid");
  }
  const namedHandlers = (rawNamedHandlers ?? []).map((handler) => {
    if (!record(handler) || typeof handler.name !== "string") {
      throw new Error("platform_worker_release_version_invalid");
    }
    return handler.name;
  });
  const handlers = new Set([
    ...(value.resources.script.handlers as readonly string[]),
    ...namedHandlers,
  ]);
  if (!handlers.has("fetch")) {
    throw new Error("platform_worker_release_fetch_handler_missing");
  }
}

async function readSecretNames(config: string): Promise<readonly string[]> {
  const result = await requiredCommand([
    WRANGLER,
    "secret",
    "list",
    "--format",
    "json",
    "--config",
    config,
  ]);
  return secretNames(result.stdout);
}

async function assertSecretNamesUnchanged(
  config: string,
  expectedDigest: string,
): Promise<void> {
  const names = await readSecretNames(config);
  if (
    digest(new TextEncoder().encode(JSON.stringify(names))) !== expectedDigest
  ) {
    throw new Error("platform_worker_release_secret_list_drift");
  }
}

async function verifyPublishedVersion(
  config: string,
  versionId: string,
): Promise<void> {
  const version = await requiredCommand([
    WRANGLER,
    "versions",
    "view",
    versionId,
    "--config",
    config,
    "--json",
  ]);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(config),
  );
  const configuredEnvironment =
    /^TAKOSUMI_ENVIRONMENT\s*=\s*"(staging|production)"\s*$/mu.exec(
      source,
    )?.[1];
  if (!configuredEnvironment) {
    throw new Error("platform_worker_release_config_source_invalid");
  }
  assertPublishedVersion(
    version.stdout,
    platformTargetForEnvironment(configuredEnvironment).hostedService,
  );
}

async function readServingVersion(config: string): Promise<string> {
  const result = await requiredCommand([
    WRANGLER,
    "deployments",
    "status",
    "--config",
    config,
    "--json",
  ]);
  return parseServingVersion(result.stdout);
}

async function waitForServingVersion(
  config: string,
  predecessor: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const current = await readServingVersion(config);
    if (current !== predecessor) return current;
    if (attempt < 8) await Bun.sleep(attempt * 1_000);
  }
  throw new Error("platform_worker_release_deployment_not_converged");
}

async function verifyPublicReadback(
  environment: PlatformEnvironment,
  expectedVersionId: string,
): Promise<void> {
  const target = platformTargetForEnvironment(environment);
  for (const path of ["/", "/.well-known/takosumi"] as const) {
    let matched = false;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        const response = await fetch(`${target.origin}${path}`, {
          headers: { "cache-control": "no-cache" },
          redirect: "manual",
        });
        if (
          response.status === 200 &&
          response.headers.get("x-takosumi-version-id") === expectedVersionId
        ) {
          if (path === "/") matched = true;
          else
            matched = hasHostedDiscovery(
              (await response.json()) as unknown,
              target.origin,
            );
        }
        if (matched) break;
      } catch {
        // Readback retries only; the publication is never retried.
      }
      if (attempt < 8) await Bun.sleep(attempt * 1_000);
    }
    if (!matched)
      throw new Error("platform_worker_release_public_readback_invalid");
  }
}

function hasHostedDiscovery(value: unknown, origin: string): boolean {
  if (
    !record(value) ||
    !record(value.endpoints) ||
    !record(value.endpoints.extensions)
  ) {
    return false;
  }
  const extensions = value.endpoints.extensions;
  return (
    extensions["takosumi.account.subscription.v1"] ===
      `${origin}/api/v1/account/subscription` &&
    extensions["openai.chat-completions.v1"] === `${origin}/api/v1/ai`
  );
}

export function assertConfigTargetsSource(
  source: string,
  path: string,
  environment: PlatformEnvironment,
): void {
  const target = platformTargetForEnvironment(environment);
  const main = /^main\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const assets = /^directory\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const name = /^name\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const configuredEnvironment =
    /^TAKOSUMI_ENVIRONMENT\s*=\s*"([^"]+)"\s*$/mu.exec(source)?.[1];
  const services = [
    ...source.matchAll(
      /\[\[services\]\]\s+binding\s*=\s*"([^"]+)"\s+service\s*=\s*"([^"]+)"/gmu,
    ),
  ];
  const hostedServices = services.filter((entry) => entry[1] === "HOSTED");
  let hostedRouteValid = false;
  let versionMetadataValid = false;
  try {
    const parsed = Bun.TOML.parse(source) as Record<string, unknown>;
    const versionMetadata = parsed.version_metadata;
    versionMetadataValid =
      record(versionMetadata) &&
      versionMetadata.binding === "TAKOSUMI_VERSION_METADATA";
    const vars = parsed.vars as Record<string, unknown> | undefined;
    const descriptors = JSON.parse(
      String(vars?.TAKOSUMI_PLATFORM_EXTENSIONS),
    ) as unknown;
    if (Array.isArray(descriptors)) {
      const hosted = descriptors.filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).handlerKey === "HOSTED",
      );
      hostedRouteValid =
        hosted.length === 2 &&
        hosted.some(matchesHostedSponsorshipRoute) &&
        hosted.some(matchesHostedAiRoute);
    }
  } catch {
    hostedRouteValid = false;
  }
  if (
    name !== target.workerName ||
    configuredEnvironment !== environment ||
    hostedServices.length !== 1 ||
    hostedServices[0]?.[2] !== target.hostedService ||
    !hostedRouteValid ||
    !versionMetadataValid ||
    !main ||
    !assets ||
    resolve(dirname(path), main) !==
      resolve(ROOT, "deploy/platform/entry-worker.ts") ||
    resolve(dirname(path), assets) !== resolve(ROOT, "dashboard/dist")
  ) {
    throw new Error("platform_worker_release_config_source_invalid");
  }
}

function matchesHostedSponsorshipRoute(value: unknown): boolean {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify(
        [
          "authDelivery",
          "basePath",
          "capabilities",
          "handlerKey",
          "id",
          "ownsPathSubtree",
          "contributions",
          "providerCredentialBroker",
          "requestScopeRules",
          "runCredential",
          "selfServicePatScopes",
          "workspaceContext",
        ].sort(),
      ) &&
    value.id === "takosumi-hosted-sponsorship" &&
    value.basePath === "/api/v1/account/subscription" &&
    value.handlerKey === "HOSTED" &&
    value.authDelivery === "context" &&
    value.ownsPathSubtree === true &&
    value.workspaceContext === "query-required" &&
    Array.isArray(value.selfServicePatScopes) &&
    value.selfServicePatScopes.length === 1 &&
    value.selfServicePatScopes[0] === "resources:read" &&
    matchesHostedInventoryScopeRules(value.requestScopeRules) &&
    Array.isArray(value.capabilities) &&
    JSON.stringify(value.capabilities) ===
      JSON.stringify([
        "takosumi.account.subscription.v1",
        "hosted-resource.inventory.v1",
      ]) &&
    matchesHostedInventoryContribution(value.contributions) &&
    matchesHostedRunCredential(value.runCredential) &&
    matchesHostedProviderCredentialBroker(value.providerCredentialBroker)
  );
}

function matchesHostedAiRoute(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "authDelivery",
          "basePath",
          "capabilities",
          "handlerKey",
          "id",
          "ownsPathSubtree",
          "requestScopeRules",
          "selfServicePatScopes",
        ].sort(),
      ) &&
    value.id === "takosumi-ai" &&
    value.basePath === "/api/v1/ai" &&
    value.handlerKey === "HOSTED" &&
    value.authDelivery === "context" &&
    value.ownsPathSubtree === true &&
    JSON.stringify(value.selfServicePatScopes) ===
      JSON.stringify(["ai.models.read", "ai.chat"]) &&
    JSON.stringify(value.requestScopeRules) ===
      JSON.stringify([
        {
          path: "/models",
          methods: ["GET"],
          requiredScopes: ["ai.models.read"],
        },
        {
          path: "/chat/completions",
          methods: ["POST"],
          requiredScopes: ["ai.chat"],
        },
      ]) &&
    JSON.stringify(value.capabilities) ===
      JSON.stringify(["openai.models.v1", "openai.chat-completions.v1"])
  );
}

function matchesHostedInventoryScopeRules(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) {
    return false;
  }
  const rule = value[0];
  return (
    JSON.stringify(Object.keys(rule).sort()) ===
      JSON.stringify(["methods", "path", "requiredScopes"]) &&
    rule.path === "/resources" &&
    JSON.stringify(rule.methods) === JSON.stringify(["GET"]) &&
    JSON.stringify(rule.requiredScopes) === JSON.stringify(["resources:read"])
  );
}

function matchesHostedInventoryContribution(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) {
    return false;
  }
  const contribution = value[0];
  return (
    JSON.stringify(Object.keys(contribution).sort()) ===
      JSON.stringify(
        [
          "description",
          "descriptions",
          "href",
          "id",
          "label",
          "labels",
          "presentation",
          "slot",
        ].sort(),
      ) &&
    contribution.id === "takoserver-hosted-resources" &&
    contribution.slot === "workspace.hosted-resources" &&
    contribution.href === "/api/v1/account/subscription/resources" &&
    contribution.presentation === "native" &&
    contribution.label === "Hosted resources" &&
    contribution.description ===
      "Resources managed by Takoserver for this Workspace." &&
    record(contribution.labels) &&
    JSON.stringify(contribution.labels) ===
      JSON.stringify({ ja: "ホスト済みリソース" }) &&
    record(contribution.descriptions) &&
    JSON.stringify(contribution.descriptions) ===
      JSON.stringify({
        ja: "このワークスペースでTakoserverが管理するリソースです。",
      })
  );
}

function matchesHostedRunCredential(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["audience", "requiredScopes"]) &&
    value.audience === "takosumi-hosted.takoform.v1" &&
    Array.isArray(value.requiredScopes) &&
    value.requiredScopes.length === 1 &&
    value.requiredScopes[0] === "takoform.run"
  );
}

function matchesHostedProviderCredentialBroker(value: unknown): boolean {
  if (!record(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(
        [
          "connectionId",
          "displayName",
          "envNames",
          "exchangePath",
          "providerSource",
          "recipeId",
          "runCredentialSettings",
        ].sort(),
      ) &&
    value.connectionId === "conn_takoserverTakoform01" &&
    value.recipeId === "takoserver-takoform-run-v1" &&
    value.providerSource === "registry.terraform.io/tako0614/takoform" &&
    value.displayName === "Takoserver" &&
    value.exchangePath === "/provider-credentials/takoform" &&
    record(value.runCredentialSettings) &&
    JSON.stringify(value.runCredentialSettings) ===
      JSON.stringify({ requiredAvailableMinor: 2300 }) &&
    Array.isArray(value.envNames) &&
    value.envNames.length === 3 &&
    value.envNames.every(
      (name) =>
        typeof name === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(name),
    ) &&
    new Set(value.envNames).size === value.envNames.length
  );
}

function assertCleanAndPushed(): void {
  if (git(["status", "--porcelain", "--untracked-files=all"]).trim() !== "") {
    throw new Error("platform_worker_release_source_dirty");
  }
  if (
    !git(["branch", "-r", "--contains", "HEAD"])
      .split("\n")
      .some((line) => line.trim().startsWith("origin/"))
  ) {
    throw new Error("platform_worker_release_source_not_pushed");
  }
}

function assertReadableConfig(path: string): void {
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    realpathSync(path) !== path
  ) {
    throw new Error("platform_worker_release_config_invalid");
  }
}

function assertPrivateFile(path: string): void {
  const status = lstatSync(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0 ||
    realpathSync(path) !== path
  ) {
    throw new Error("platform_worker_release_private_file_invalid");
  }
}

function assertExternalAbsent(path: string): void {
  if (insideRoot(path))
    throw new Error("platform_worker_release_output_must_be_external");
  const parent = dirname(path);
  const status = lstatSync(parent);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  ) {
    throw new Error("platform_worker_release_output_parent_invalid");
  }
  try {
    lstatSync(path);
    throw new Error("platform_worker_release_output_exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writePrivate(path: string, bytes: Uint8Array): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

async function requiredCommand(
  argv: readonly string[],
  stdin?: Uint8Array,
  cwd = ROOT,
  environment = childEnvironment(),
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    cwd,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: environment,
  });
  if (stdin !== undefined) {
    if (!child.stdin)
      throw new Error("platform_worker_release_stdin_unavailable");
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
  const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
    child.exited,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
  ]).finally(() => clearTimeout(timer));
  if (
    stdoutBytes.byteLength > MAX_OUTPUT ||
    stderrBytes.byteLength > MAX_OUTPUT ||
    exitCode !== 0
  ) {
    throw new Error("platform_worker_release_command_failed");
  }
  return {
    exitCode,
    stdout: new TextDecoder("utf-8", { fatal: true }).decode(stdoutBytes),
    stderr: new TextDecoder("utf-8", { fatal: true }).decode(stderrBytes),
  };
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnvironment(),
  });
  if (result.exitCode !== 0)
    throw new Error("platform_worker_release_git_failed");
  return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = Bun.spawnSync(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    {
      cwd: ROOT,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnvironment(),
    },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error("platform_worker_release_git_failed");
}

function childEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "true",
  };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function absolute(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error("platform_worker_release_path_invalid");
  }
  return value;
}

function insideRoot(path: string): boolean {
  const child = relative(ROOT, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visit(
  value: unknown,
  callback: (entry: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!record(value)) return;
  callback(value);
  for (const child of Object.values(value)) visit(child, callback);
}
