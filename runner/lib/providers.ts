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
  PlanScopeSelector,
  TerraformTreeProviderScan,
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
import { parseSource, parseRequiredProviders } from "./parsing.ts";
import { canonicalProviderSource } from "../../contract/provider-env-rules.ts";

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
): Promise<TerraformTreeProviderScan> {
  const declared = parseRequiredProviders(request);
  const observed = await requiredProviderSourcesFromTerraformTree(rootDir);
  return {
    providers: normalizedProviderList([...declared, ...observed.providers]),
    complete: observed.complete,
  };
}

/**
 * OpenTofu loads `.tf` / `.tofu` (HCL) and `.tf.json` / `.tofu.json` (JSON)
 * config files. A scanner that only looks at `.tf` would let a provider
 * declared in any of the other three spellings reach `tofu init` unseen by the
 * runner provider policy.
 */
function terraformConfigFileKind(name: string): "hcl" | "json" | undefined {
  if (name.endsWith(".tf.json") || name.endsWith(".tofu.json")) return "json";
  if (name.endsWith(".tf") || name.endsWith(".tofu")) return "hcl";
  return undefined;
}

export async function requiredProviderSourcesFromTerraformTree(
  rootDir: string,
): Promise<TerraformTreeProviderScan> {
  let files = 0;
  let totalBytes = 0;
  const providers: string[] = [];
  const stack = [rootDir];
  // A scan that stops early (unreadable directory, DoS caps, unparsable JSON)
  // yields a provider list that looks exactly like a clean one. It is reported
  // as incomplete so provider policy fails closed instead of enforcing itself
  // against providers it never saw.
  const incomplete = (): TerraformTreeProviderScan => ({
    providers: normalizedProviderList(providers),
    complete: false,
  });
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return incomplete();
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
      if (!entry.isFile()) continue;
      const kind = terraformConfigFileKind(entry.name);
      if (!kind) continue;
      files += 1;
      if (files > CAPSULE_COMPATIBILITY_MAX_FILES) return incomplete();
      const info = await stat(path);
      if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) {
        return incomplete();
      }
      totalBytes += info.size;
      if (totalBytes > CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES) {
        return incomplete();
      }
      const text = await readFile(path, "utf8");
      if (kind === "hcl") {
        providers.push(...requiredProviderSourcesFromTerraformText(text));
        continue;
      }
      const json = requiredProviderSourcesFromTerraformJson(text);
      if (!json) return incomplete();
      providers.push(...json);
    }
  }
  return { providers: normalizedProviderList(providers), complete: true };
}

/**
 * Provider sources declared by a JSON config file. `undefined` means the file
 * could not be parsed, so its provider declarations are unknown.
 */
export function requiredProviderSourcesFromTerraformJson(
  text: string,
): readonly string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const providers: string[] = [];
  collectRequiredProviderSources(parsed, providers);
  return normalizedProviderList(providers);
}

function collectRequiredProviderSources(
  value: unknown,
  providers: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRequiredProviderSources(item, providers);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "required_providers") {
      collectProviderSourceStrings(child, providers);
      continue;
    }
    collectRequiredProviderSources(child, providers);
  }
}

function collectProviderSourceStrings(
  value: unknown,
  providers: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProviderSourceStrings(item, providers);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "source" && typeof child === "string") {
      const source = child.trim();
      if (source.includes("/")) providers.push(source);
      continue;
    }
    collectProviderSourceStrings(child, providers);
  }
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
  parseSource(request);
  const requiredProviders =
    options.requiredProviders ?? parseRequiredProviders(request);
  const allowedProviders = stringArray(
    recordField(runnerProfile, "allowedProviders"),
  );
  const deniedProviders = stringArray(
    recordField(runnerProfile, "deniedProviders"),
  );
  if (
    (allowedProviders.length > 0 || deniedProviders.length > 0) &&
    options.providerScanComplete === false
  ) {
    // An incomplete scan looks exactly like a clean one, so enforcing the
    // allow/deny list against it would let an oversized or unreadable source
    // tree smuggle an unlisted provider past the gate.
    throw new Error(
      `runner profile ${stringField(runnerProfile, "id") ?? "<unknown>"} cannot enforce its provider policy: the generated-root provider scan did not complete`,
    );
  }
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
  assertCredentialEnvAvailable(
    requiredProviders,
    runnerProfile,
    context.env,
    context.credentialManifest,
  );
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
      if (!entry.isFile()) continue;
      const kind = terraformConfigFileKind(entry.name);
      if (!kind) continue;
      files += 1;
      if (files > CAPSULE_COMPATIBILITY_MAX_FILES) return false;
      const info = await stat(path);
      if (info.size > CAPSULE_COMPATIBILITY_MAX_FILE_BYTES) return false;
      totalBytes += info.size;
      if (totalBytes > CAPSULE_COMPATIBILITY_MAX_TOTAL_BYTES) return false;
      // A JSON config file is loaded by `tofu init` exactly like an HCL one.
      // The HCL text probe cannot speak for it, so its mere presence means the
      // root is not provably provider-free.
      if (kind === "json") return false;
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
  const strict =
    policy?.requireMirror === true && canonicalProviders.length > 0;
  const mirrorRoot =
    Bun.env.OPENTOFU_PROVIDER_MIRROR ?? DEFAULT_PROVIDER_MIRROR_PATH;
  // Strict mode promises the run installs providers ONLY from the operator
  // filesystem mirror. A plugin cache breaks that promise: the container-wide
  // one is writable by every run in this container, so an earlier run for
  // another Workspace could seed the binaries this run installs. Strict runs
  // therefore get no plugin cache at all.
  const providerCache = strict
    ? undefined
    : providerPluginCacheForWorkspace(workspace);
  const content = providerCache
    ? defaultProviderMirrorCliConfig(mirrorRoot, providerCache.path)
    : strictProviderMirrorCliConfig(canonicalProviders, mirrorRoot);
  const cliConfigPath = join(workspace.root, "takosumi.tofu.rc");
  await mkdir(workspace.root, { recursive: true });
  if (providerCache) await mkdir(providerCache.path, { recursive: true });
  await writeFile(cliConfigPath, content, { mode: 0o600 });
  const cliConfigDigest = await digestBytes(new TextEncoder().encode(content));
  return {
    ...(providerCache ? { providerCacheDir: providerCache.path } : {}),
    sharedProviderCache: providerCache?.shared === true,
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

export function providerPluginCacheForWorkspace(workspace: RunWorkspace): {
  readonly path: string;
  readonly shared: boolean;
} {
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
  if (!init?.sharedProviderCache || !init.providerCacheDir) return await run();
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
): string {
  const providerLines = providers
    .map((provider) => `      ${JSON.stringify(provider)}`)
    .join(",\n");
  return `provider_installation {
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
  return `plugin_cache_dir = ${JSON.stringify(providerCache)}

provider_installation {
  filesystem_mirror {
    path = ${JSON.stringify(mirrorRoot)}
  }

  direct {}
}
`;
}

export function canonicalProviderAddress(provider: string): string {
  return canonicalProviderSource(provider);
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

/**
 * Returns only allowlisted, fully-known, non-sensitive root outputs from a
 * reviewed OpenTofu plan. This is intentionally narrower than the encrypted
 * plan JSON artifact: it exists so the controller can resolve declarative
 * service connections before the final saved plan is produced.
 */
export function plannedOutputsFromPlanJson(
  planJson: string,
  outputAllowlist:
    | Readonly<
        Record<string, { readonly from: string; readonly sensitive?: boolean }>
      >
    | undefined,
): JsonRecord | undefined {
  if (!outputAllowlist || Object.keys(outputAllowlist).length === 0) {
    return undefined;
  }
  const parsed = JSON.parse(planJson) as { readonly output_changes?: unknown };
  if (!isRecord(parsed.output_changes)) return undefined;
  const requested = new Set(
    Object.values(outputAllowlist).flatMap((entry) =>
      entry.sensitive === true ? [] : [entry.from],
    ),
  );
  const outputs: JsonRecord = {};
  for (const name of requested) {
    const change = recordField(parsed.output_changes, name);
    if (!change) continue;
    const after = recordField(change, "after");
    if (after === undefined) continue;
    if (containsTrue(recordField(change, "after_unknown"))) continue;
    if (containsTrue(recordField(change, "after_sensitive"))) continue;
    if (!isJsonValue(after)) continue;
    outputs[name] = { sensitive: false, value: after };
  }
  return Object.keys(outputs).length > 0 ? outputs : undefined;
}

function containsTrue(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsTrue);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsTrue);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

// Trimmed per-resource change list (address/type/actions only) extracted from
// `tofu show -json tfplan`. Used by the plan-JSON policy on the service side.
export function resourceChangesFromPlanJson(
  planJson: string,
  scopeSelectors?: readonly PlanScopeSelector[],
): Array<{
  address: string;
  type: string;
  providerSource?: string;
  actions: string[];
  importing?: true;
  scope?: { facts: Record<string, string | number | boolean> };
}> {
  const parsed = JSON.parse(planJson) as {
    readonly resource_changes?: unknown;
  };
  const out: Array<{
    address: string;
    type: string;
    providerSource?: string;
    actions: string[];
    importing?: true;
    scope?: { facts: Record<string, string | number | boolean> };
  }> = [];
  if (!Array.isArray(parsed.resource_changes)) return out;
  for (const changeRecord of parsed.resource_changes) {
    const address = stringField(changeRecord, "address");
    const type = stringField(changeRecord, "type");
    const providerSource = stringField(changeRecord, "provider_name");
    const change = recordField(changeRecord, "change");
    const actions = recordField(change, "actions");
    const importing = recordField(change, "importing");
    if (!address || !type || !Array.isArray(actions)) continue;
    const resourceChange = {
      address,
      type,
      ...(providerSource ? { providerSource } : {}),
      actions: actions.filter(
        (action): action is string => typeof action === "string",
      ),
      ...(isRecord(importing) ? { importing: true as const } : {}),
      ...scopeProjectionForPlanResource(type, change, scopeSelectors),
    };
    out.push(resourceChange);
  }
  return out;
}

export function scopeProjectionForPlanResource(
  type: string,
  change: unknown,
  selectors: readonly PlanScopeSelector[] = [],
): { scope?: { facts: Record<string, string | number | boolean> } } {
  const matching = selectors.filter((selector) =>
    resourceTypeMatchesPattern(type, selector.resourceTypePattern),
  );
  if (matching.length === 0) return {};
  const facts: Record<string, string | number | boolean> = {};
  const ambiguous = new Set<string>();
  for (const selector of matching) {
    for (const [dimension, pointer] of Object.entries(selector.dimensions)) {
      if (ambiguous.has(dimension)) continue;
      const value = selectedNonSecretScalar(change, pointer);
      if (value === undefined) continue;
      const existing = facts[dimension];
      if (existing !== undefined && existing !== value) {
        delete facts[dimension];
        ambiguous.add(dimension);
        continue;
      }
      facts[dimension] = value;
    }
  }
  return Object.keys(facts).length > 0 ? { scope: { facts } } : {};
}

function selectedNonSecretScalar(
  change: unknown,
  pointer: string,
): string | number | boolean | undefined {
  const after = recordField(change, "after");
  const phase = after === undefined || after === null ? "before" : "after";
  const source = phase === "after" ? after : recordField(change, "before");
  if (source === undefined || source === null) return undefined;
  const selected = jsonPointerLookup(source, pointer);
  if (!selected.found || !isScopeScalar(selected.value)) return undefined;
  const sensitive = recordField(change, `${phase}_sensitive`);
  const unknown = recordField(change, `${phase}_unknown`);
  if (jsonPointerBlocked(sensitive, pointer)) return undefined;
  if (jsonPointerBlocked(unknown, pointer)) return undefined;
  return selected.value;
}

function jsonPointerLookup(
  value: unknown,
  pointer: string,
): { readonly found: boolean; readonly value?: unknown } {
  let current = value;
  for (const segment of jsonPointerSegments(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !(segment in current)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}

function jsonPointerBlocked(mask: unknown, pointer: string): boolean {
  let current = mask;
  if (current === true) return true;
  for (const segment of jsonPointerSegments(pointer)) {
    if (Array.isArray(current)) {
      const index = /^(?:0|[1-9][0-9]*)$/u.test(segment) ? Number(segment) : -1;
      current = index >= 0 ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return false;
    }
    if (current === true) return true;
  }
  return false;
}

function jsonPointerSegments(pointer: string): readonly string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function isScopeScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function resourceTypeMatchesPattern(type: string, pattern: string): boolean {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(type);
}
