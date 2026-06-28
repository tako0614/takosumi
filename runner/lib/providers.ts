// runner/lib/providers.ts
//
// Provider discovery, runner-policy-before-init, strict provider-mirror init, plan-JSON projection.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  JsonRecord,
  RunWorkspace,
  CommandContext,
  RunnerPolicyBeforeInitOptions,
  StrictProviderMirrorAttestation,
  ProviderMirrorInit,
} from "./types.ts";
import {
  CAPSULE_COMPATIBILITY_MAX_FILES,
  CAPSULE_COMPATIBILITY_MAX_FILE_BYTES,
  CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES,
  DEFAULT_PROVIDER_MIRROR_PATH,
  PROVIDER_PLUGIN_CACHE_DIR_ENV,
} from "./constants.ts";
import {
  isRecord,
  recordField,
  stringField,
  stringArray,
  providerMatches,
  digestBytes,
  pathExists,
  digestPathIfExists,
} from "./util.ts";
import {
  commandContextFromRequest,
  assertCredentialEnvAvailable,
} from "./credentials.ts";
import {
  parseSource,
  parseRequiredProviders,
} from "./parsing.ts";

const DEFAULT_MIRRORED_PROVIDERS = [
  "registry.opentofu.org/cloudflare/cloudflare",
  "registry.opentofu.org/hashicorp/random",
  "registry.opentofu.org/hashicorp/tls",
  "registry.opentofu.org/hashicorp/aws",
] as const;

const providerCacheInitLocks = new Map<string, Promise<void>>();

export function assertRunnerPolicyForRequest(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
): void {
  assertRunnerPolicyBeforeInit(
    request,
    runnerProfile,
    commandContextFromRequest(request, runnerProfile),
  );
}

export async function requiredProvidersForGeneratedRoot(
  request: unknown,
  rootDir: string,
): Promise<readonly string[]> {
  const declared = parseRequiredProviders(request);
  const observed = await requiredProviderSourcesFromTerraformTree(rootDir);
  return normalizedProviderList([...declared, ...observed]);
}

export async function requiredProviderSourcesFromTerraformTree(
  rootDir: string,
): Promise<readonly string[]> {
  let files = 0;
  let totalBytes = 0;
  const providers: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".terraform" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".tf")) continue;
      files += 1;
      if (files > CAPSULE_COMPATIBILITY_MAX_FILES) return [];
      const info = await stat(path);
      if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) return [];
      totalBytes += info.size;
      if (totalBytes > CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES) return [];
      providers.push(
        ...requiredProviderSourcesFromTerraformText(
          await readFile(path, "utf8"),
        ),
      );
    }
  }
  return normalizedProviderList(providers);
}

export function requiredProviderSourcesFromTerraformText(
  text: string,
): readonly string[] {
  const providers: string[] = [];
  let searchFrom = 0;
  while (true) {
    const keyword = text.indexOf("required_providers", searchFrom);
    if (keyword === -1) break;
    const open = text.indexOf("{", keyword);
    if (open === -1) break;
    let depth = 0;
    let close = -1;
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close === -1) break;
    const body = text.slice(open + 1, close);
    for (const match of body.matchAll(/\bsource\s*=\s*"([^"]+)"/gu)) {
      const source = match[1]?.trim();
      if (source && source.includes("/")) providers.push(source);
    }
    searchFrom = close + 1;
  }
  return normalizedProviderList(providers);
}

export function assertRunnerPolicyBeforeInit(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
  context: CommandContext,
  options: RunnerPolicyBeforeInitOptions = {},
): void {
  if (!runnerProfile) return;
  const source = parseSource(request);
  if (
    source.kind === "local" &&
    recordField(
      recordField(runnerProfile, "sourcePolicy"),
      "allowLocalSource",
    ) !== true
  ) {
    throw new Error(
      `runner profile ${stringField(runnerProfile, "id") ?? "<unknown>"} does not allow local source paths`,
    );
  }
  const requiredProviders =
    options.requiredProviders ?? parseRequiredProviders(request);
  const allowedProviders = stringArray(
    recordField(runnerProfile, "allowedProviders"),
  );
  const deniedProviders = stringArray(
    recordField(runnerProfile, "deniedProviders"),
  );
  if (
    allowedProviders.length > 0 &&
    requiredProviders.length === 0 &&
    options.allowProviderFreeGeneratedRoot !== true
  ) {
    throw new Error(
      `runner profile ${stringField(runnerProfile, "id") ?? "<unknown>"} requires requiredProviders before OpenTofu init`,
    );
  }
  for (const provider of requiredProviders) {
    if (deniedProviders.some((denied) => providerMatches(provider, denied))) {
      throw new Error(`provider ${provider} is denied before OpenTofu init`);
    }
    if (
      allowedProviders.length > 0 &&
      !allowedProviders.some(
        (allowed) => allowed === "*" || providerMatches(provider, allowed),
      )
    ) {
      throw new Error(
        `provider ${provider} is not allowed before OpenTofu init`,
      );
    }
  }
  assertCredentialEnvAvailable(requiredProviders, runnerProfile, context.env);
}

export async function generatedRootTreeHasNoProviderUsage(
  rootDir: string,
): Promise<boolean> {
  let files = 0;
  let totalBytes = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (
        entry.name === ".git" ||
        entry.name === ".terraform" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".tf")) continue;
      files += 1;
      if (files > CAPSULE_COMPATIBILITY_MAX_FILES) return false;
      const info = await stat(path);
      if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) return false;
      totalBytes += info.size;
      if (totalBytes > CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES) return false;
      const text = await readFile(path, "utf8");
      if (hasProviderUsageBeforeInit(text)) return false;
    }
  }
  return files > 0;
}

export function hasProviderUsageBeforeInit(text: string): boolean {
  const normalized = text.replace(/\brequired_providers\s*\{\s*\}/gu, "");
  return /\brequired_providers\b|\bprovider\s+"|\bresource\s+"|\bdata\s+"|\bbackend\s+"/u.test(
    normalized,
  );
}

export function providersFromPlanJson(planJson: string): readonly string[] {
  const parsed = JSON.parse(planJson) as JsonRecord;
  const providers = new Set<string>();
  collectProviderFullNames(parsed, providers);
  return Array.from(providers).sort();
}

export function normalizedProviderList(
  providers: readonly string[],
): readonly string[] {
  return Array.from(new Set(providers.map(canonicalProviderAddress))).sort();
}

export async function providerInstallationEvidence(
  moduleDir: string,
  providers: readonly string[],
  attestation?: StrictProviderMirrorAttestation,
): Promise<
  readonly {
    readonly provider: string;
    readonly mirrored: boolean;
    readonly installationMethod: "filesystem_mirror" | "direct" | "unknown";
    readonly mirrorPath?: string;
    readonly attested?: boolean;
    readonly attestationMethod?: "forced_filesystem_mirror_init";
    readonly cliConfigDigest?: string;
    readonly installedPath?: string;
    readonly installedDigest?: string;
  }[]
> {
  const mirrorRoot =
    Bun.env.OPENTOFU_PROVIDER_MIRROR ?? DEFAULT_PROVIDER_MIRROR_PATH;
  const attestedProviders = new Set(attestation?.providers ?? []);
  const rows = await Promise.all(
    providers.map(async (provider) => {
      const canonical = canonicalProviderAddress(provider);
      const mirrorPath = join(mirrorRoot, ...canonical.split("/"));
      const installedPath = join(
        moduleDir,
        ".terraform",
        "providers",
        ...canonical.split("/"),
      );
      const mirrored = await pathExists(mirrorPath);
      const installedDigest = await digestPathIfExists(installedPath);
      const attested = mirrored && attestedProviders.has(canonical);
      return {
        provider: canonical,
        mirrored,
        installationMethod: mirrored ? "filesystem_mirror" : "direct",
        mirrorPath,
        ...(installedDigest ? { installedDigest } : {}),
        ...(attested
          ? {
              attested: true,
              attestationMethod: "forced_filesystem_mirror_init" as const,
              installedPath,
              ...(attestation
                ? { cliConfigDigest: attestation.cliConfigDigest }
                : {}),
            }
          : {}),
      } as const;
    }),
  );
  return rows.sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
}

export async function prepareStrictProviderMirrorInit(
  workspace: RunWorkspace,
  context: CommandContext,
  providers: readonly string[],
  policy: { readonly requireMirror: boolean } | undefined,
): Promise<ProviderMirrorInit | undefined> {
  const canonicalProviders = normalizedProviderList(providers);
  const strict = policy?.requireMirror === true && canonicalProviders.length > 0;
  const mirrorRoot =
    Bun.env.OPENTOFU_PROVIDER_MIRROR ?? DEFAULT_PROVIDER_MIRROR_PATH;
  const providerCache = providerPluginCacheForWorkspace(workspace);
  const content = strict
    ? strictProviderMirrorCliConfig(
        canonicalProviders,
        mirrorRoot,
        providerCache.path,
      )
    : defaultProviderMirrorCliConfig(mirrorRoot, providerCache.path);
  const cliConfigPath = join(workspace.root, "takosumi.tofu.rc");
  await mkdir(workspace.root, { recursive: true });
  await mkdir(providerCache.path, { recursive: true });
  await writeFile(cliConfigPath, content, { mode: 0o600 });
  const cliConfigDigest = await digestBytes(new TextEncoder().encode(content));
  return {
    providerCacheDir: providerCache.path,
    sharedProviderCache: providerCache.shared,
    commandContext: {
      ...context,
      env: {
        ...context.env,
        TF_CLI_CONFIG_FILE: cliConfigPath,
      },
    },
    ...(strict
      ? {
          attestation: {
            providers: canonicalProviders,
            cliConfigPath,
            cliConfigDigest,
          },
        }
      : {}),
  };
}

export function providerPluginCacheForWorkspace(
  workspace: RunWorkspace,
): { readonly path: string; readonly shared: boolean } {
  const configured = Bun.env[PROVIDER_PLUGIN_CACHE_DIR_ENV]?.trim();
  if (configured) {
    return { path: configured, shared: true };
  }
  return { path: join(workspace.root, "provider-cache"), shared: false };
}

export async function withProviderPluginCacheInitLock<T>(
  init: ProviderMirrorInit | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!init?.sharedProviderCache) return await run();
  const key = init.providerCacheDir;
  const previous = providerCacheInitLocks.get(key) ?? Promise.resolve();
  const ready = previous.catch(() => {});
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = ready.then(() => current);
  providerCacheInitLocks.set(key, tail);
  await ready;
  try {
    return await run();
  } finally {
    release();
    if (providerCacheInitLocks.get(key) === tail) {
      providerCacheInitLocks.delete(key);
    }
  }
}

export function strictProviderMirrorCliConfig(
  providers: readonly string[],
  mirrorRoot: string,
  providerCache: string,
): string {
  const providerLines = providers
    .map((provider) => `      ${JSON.stringify(provider)}`)
    .join(",\n");
  return `plugin_cache_dir = ${JSON.stringify(providerCache)}

provider_installation {
  filesystem_mirror {
    path = ${JSON.stringify(mirrorRoot)}
    include = [
${providerLines}
    ]
  }

  direct {
    exclude = ["*/*"]
  }
}
`;
}

export function defaultProviderMirrorCliConfig(
  mirrorRoot: string,
  providerCache: string,
): string {
  const providerLines = DEFAULT_MIRRORED_PROVIDERS.map(
    (provider) => `      ${JSON.stringify(provider)}`,
  ).join(",\n");
  return `plugin_cache_dir = ${JSON.stringify(providerCache)}

provider_installation {
  filesystem_mirror {
    path = ${JSON.stringify(mirrorRoot)}
    include = [
${providerLines}
    ]
  }

  direct {
    exclude = [
${providerLines}
    ]
  }
}
`;
}

export function canonicalProviderAddress(provider: string): string {
  const segments = provider.split("/").filter((part) => part.length > 0);
  if (segments.length === 2) return `registry.opentofu.org/${provider}`;
  return provider;
}

export function collectProviderFullNames(
  value: unknown,
  providers: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderFullNames(item, providers);
    return;
  }
  if (!isRecord(value)) return;
  const fullName = value.full_name;
  if (typeof fullName === "string" && fullName.includes("/")) {
    providers.add(fullName);
  }
  for (const child of Object.values(value))
    collectProviderFullNames(child, providers);
}

export function summaryFromPlanJson(planJson: string): {
  readonly add: number;
  readonly change: number;
  readonly destroy: number;
} {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: unknown;
  };
  let add = 0;
  let change = 0;
  let destroy = 0;
  if (Array.isArray(parsed.resource_changes)) {
    for (const changeRecord of parsed.resource_changes) {
      const actions = recordField(
        recordField(changeRecord, "change"),
        "actions",
      );
      if (!Array.isArray(actions)) continue;
      if (actions.includes("create")) add++;
      if (actions.includes("update")) change++;
      if (actions.includes("delete")) destroy++;
    }
  }
  return { add, change, destroy };
}

// Trimmed per-resource change list (address/type/actions only) extracted from
// `tofu show -json tfplan`. Used by the plan-JSON policy on the service side.
export function resourceChangesFromPlanJson(planJson: string): Array<{
  address: string;
  type: string;
  actions: string[];
  scope?: {
    cloudflareAccountId?: string;
    cloudflareZoneId?: string;
    awsAccountId?: string;
    awsRegion?: string;
  };
}> {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: unknown;
  };
  const out: Array<{
    address: string;
    type: string;
    actions: string[];
    scope?: {
      cloudflareAccountId?: string;
      cloudflareZoneId?: string;
      awsAccountId?: string;
      awsRegion?: string;
    };
  }> = [];
  if (!Array.isArray(parsed.resource_changes)) return out;
  for (const changeRecord of parsed.resource_changes) {
    const address = stringField(changeRecord, "address");
    const type = stringField(changeRecord, "type");
    const change = recordField(changeRecord, "change");
    const actions = recordField(change, "actions");
    if (!address || !type || !Array.isArray(actions)) continue;
    const resourceChange = {
      address,
      type,
      actions: actions.filter(
        (action): action is string => typeof action === "string",
      ),
      ...scopeProjectionForPlanResource(type, change),
    };
    out.push(resourceChange);
  }
  return out;
}

export function scopeProjectionForPlanResource(
  type: string,
  change: unknown,
): {
  scope?: {
    cloudflareAccountId?: string;
    cloudflareZoneId?: string;
    awsAccountId?: string;
    awsRegion?: string;
  };
} {
  const after = recordField(change, "after");
  const before = recordField(change, "before");
  const source = after ?? before;
  if (!source) return {};
  const scope: {
    cloudflareAccountId?: string;
    cloudflareZoneId?: string;
    awsAccountId?: string;
    awsRegion?: string;
  } = {};
  if (type.startsWith("cloudflare_")) {
    const accountId =
      stringField(source, "account_id") ?? stringField(source, "accountId");
    const zoneId =
      stringField(source, "zone_id") ?? stringField(source, "zoneId");
    if (accountId) scope.cloudflareAccountId = accountId;
    if (zoneId) scope.cloudflareZoneId = zoneId;
  }
  if (type.startsWith("aws_")) {
    const accountId =
      stringField(source, "account_id") ??
      stringField(source, "accountId") ??
      stringField(source, "owner_id");
    const region = stringField(source, "region");
    if (accountId) scope.awsAccountId = accountId;
    if (region) scope.awsRegion = region;
  }
  return Object.keys(scope).length > 0 ? { scope } : {};
}
