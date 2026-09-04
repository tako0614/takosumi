// runner/lib/providers.ts
//
// Provider discovery, runner-policy-before-init, strict provider-mirror init, plan-JSON projection.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split), plus the
// owner-observed installation digest used by mutation evidence; see
// runner/entrypoint.ts for the re-exported public surface.
import { constants as fsConstants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
  parseLegacySourcelessDestroyRecovery,
  parseSource,
  parseRequiredProviders,
  parseRequiredProviderRequirements,
} from "./parsing.ts";
import {
  canonicalProviderSource,
  isOpenTofuBuiltinProviderSource,
} from "../../contract/provider-env-rules.ts";
import { resourceTypeMatchesPattern } from "../../contract/plan-scope.ts";
import {
  compileOpenTofuConfigurationGraph,
  compileOpenTofuConfigurationGraphFromLoader,
  DEFAULT_OPENTOFU_CONFIGURATION_LIMITS,
  openTofuConfigurationFileKind,
  parseOpenTofuProviderLockObservation,
  type OpenTofuModuleDirectory,
} from "../../lib/opentofu-configuration/src/mod.ts";

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
  const declaredRequirements = parseRequiredProviderRequirements(request)?.filter(
    (requirement) =>
      !isOpenTofuBuiltinProviderSource(requirement.source),
  );
  const observed = await requiredProviderSourcesFromTerraformTree(rootDir);
  if (
    declaredRequirements !== undefined &&
    JSON.stringify(declaredRequirements) !==
      JSON.stringify(observed.requirements)
  ) {
    throw new Error(
      "runner-derived provider requirements do not match the compatibility-reviewed PlanRun requirements",
    );
  }
  if (declaredRequirements !== undefined) {
    if (
      JSON.stringify(normalizedProviderList(declared)) !==
      JSON.stringify(observed.providers)
    ) {
      throw new Error(
        "PlanRun requiredProviders does not match the reachable provider package set",
      );
    }
  }
  return {
    providers: observed.providers,
    requirements: observed.requirements,
    files: observed.files,
    diagnostics: observed.diagnostics,
    complete: observed.complete,
  };
}

export async function requiredProviderSourcesFromTerraformTree(
  rootDir: string,
): Promise<TerraformTreeProviderScan> {
  let physicalRoot: string;
  try {
    physicalRoot = await realpath(rootDir);
    const rootInfo = await lstat(physicalRoot);
    if (!rootInfo.isDirectory()) throw new Error("not a directory");
  } catch {
    return incompleteProviderScan(rootDir, "OpenTofu root is unreadable.");
  }
  const graph = await compileOpenTofuConfigurationGraphFromLoader({
    loadModuleDirectory: async (directory) =>
      await loadOpenTofuModuleDirectory(physicalRoot, directory),
  });
  return {
    providers: normalizedProviderList(
      graph.providerPackages.map((providerPackage) => providerPackage.source),
    ),
    requirements: graph.rootProviderRequirements,
    files: graph.files,
    diagnostics: graph.diagnostics,
    complete: graph.complete,
  };
}

/**
 * Bind the pre-init source derivation to both the exact source tree re-read
 * and the provider package set that credential-free init wrote to the lock.
 * Any growth, alias/local-name change, disappearance, or concurrent rewrite
 * stops before Plan/apply can execute provider code.
 */
export function assertProviderSetStableAfterInit(
  before: TerraformTreeProviderScan,
  after: TerraformTreeProviderScan,
  dependencyLockText: string | undefined,
): void {
  if (!before.complete || !after.complete) {
    throw new Error(
      "OpenTofu provider configuration scan did not complete before provider execution",
    );
  }
  if (
    JSON.stringify(before.requirements) !== JSON.stringify(after.requirements)
  ) {
    throw new Error(
      "OpenTofu provider requirements changed after init and before provider execution",
    );
  }
  if (JSON.stringify(before.providers) !== JSON.stringify(after.providers)) {
    throw new Error(
      "OpenTofu provider package set changed after init and before provider execution",
    );
  }
  // OpenTofu owns the built-in provider namespace and does not write those
  // providers to `.terraform.lock.hcl`. Normalize legacy scan projections to
  // the installable-provider set before comparing them with the actual lock.
  const expectedSources = normalizedProviderList(before.providers);
  if (dependencyLockText === undefined) {
    if (expectedSources.length > 0) {
      throw new Error(
        "OpenTofu dependency lock is missing after init for required providers",
      );
    }
    return;
  }
  const observed = parseOpenTofuProviderLockObservation(dependencyLockText);
  if (!observed.complete) {
    throw new Error(
      "OpenTofu dependency lock provider set could not be parsed exactly",
    );
  }
  // A builtin row in an actual dependency lock is impossible output from
  // OpenTofu. Do not discard it: unexpected lock content remains a mismatch.
  if (JSON.stringify(expectedSources) !== JSON.stringify(observed.sources)) {
    throw new Error(
      "OpenTofu dependency lock provider set does not match the statically derived provider set",
    );
  }
}

/**
 * Provider sources declared by a JSON config file. `undefined` means the file
 * could not be parsed, so its provider declarations are unknown.
 */
export function requiredProviderSourcesFromTerraformJson(
  text: string,
): readonly string[] | undefined {
  const graph = compileOpenTofuConfigurationGraph({
    files: [{ path: "providers.tf.json", text }],
  });
  return graph.complete
    ? normalizedProviderList(
        graph.providerPackages.map((providerPackage) => providerPackage.source),
      )
    : undefined;
}

export function requiredProviderSourcesFromTerraformText(
  text: string,
): readonly string[] {
  const graph = compileOpenTofuConfigurationGraph({
    files: [{ path: "providers.tf", text }],
  });
  return normalizedProviderList(
    graph.providerPackages.map((providerPackage) => providerPackage.source),
  );
}

function incompleteProviderScan(
  path: string,
  message: string,
): TerraformTreeProviderScan {
  return {
    providers: [],
    requirements: [],
    files: [],
    diagnostics: [
      {
        code: "module_directory_unreadable",
        path,
        message,
        fatal: true,
      },
    ],
    complete: false,
  };
}

async function loadOpenTofuModuleDirectory(
  physicalRoot: string,
  directory: string,
): Promise<OpenTofuModuleDirectory> {
  const absoluteDirectory = resolve(
    physicalRoot,
    directory === "." ? "" : directory,
  );
  assertPhysicalPathInsideRoot(physicalRoot, absoluteDirectory);
  const before = await lstat(absoluteDirectory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("reachable OpenTofu module is not a physical directory");
  }
  const resolvedDirectory = await realpath(absoluteDirectory);
  if (resolvedDirectory !== absoluteDirectory) {
    throw new Error("reachable OpenTofu module traverses a symbolic link");
  }
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    if (openTofuConfigurationFileKind(entry.name) === undefined) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(
        `OpenTofu configuration ${entry.name} is not a physical regular file`,
      );
    }
    const absolutePath = resolve(absoluteDirectory, entry.name);
    assertPhysicalPathInsideRoot(physicalRoot, absolutePath);
    const file = await open(
      absolutePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const fileBefore = await file.stat();
      if (!fileBefore.isFile() || fileBefore.nlink !== 1) {
        throw new Error(
          `OpenTofu configuration ${entry.name} is not an inode-stable file`,
        );
      }
      if (
        fileBefore.size >
        DEFAULT_OPENTOFU_CONFIGURATION_LIMITS.maxFileBytes
      ) {
        throw new Error(`OpenTofu configuration ${entry.name} is too large`);
      }
      const bytes = await file.readFile();
      const fileAfter = await file.stat();
      if (!samePhysicalFile(fileBefore, fileAfter, bytes.byteLength)) {
        throw new Error(
          `OpenTofu configuration ${entry.name} changed while it was read`,
        );
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      files.push({
        path: directory === "." ? entry.name : `${directory}/${entry.name}`,
        text,
      });
    } finally {
      await file.close();
    }
  }
  const after = await lstat(absoluteDirectory);
  if (!sameDirectory(before, after)) {
    throw new Error("reachable OpenTofu module changed while it was read");
  }
  return { exists: true, files };
}

function assertPhysicalPathInsideRoot(root: string, candidate: string): void {
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    resolve(candidate) !== candidate
  ) {
    throw new Error("OpenTofu module path escapes the selected root");
  }
}

function samePhysicalFile(
  before: Stats,
  after: Stats,
  bytes: number,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === bytes &&
    after.size === bytes &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.nlink === 1 &&
    after.nlink === 1
  );
}

function sameDirectory(
  before: Stats,
  after: Stats,
): boolean {
  return (
    before.isDirectory() &&
    after.isDirectory() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertRunnerPolicyBeforeInit(
  request: unknown,
  runnerProfile: JsonRecord | undefined,
  context: CommandContext,
  options: RunnerPolicyBeforeInitOptions = {},
): void {
  if (!runnerProfile) return;
  parseLegacySourcelessDestroyRecovery(request) ?? parseSource(request);
  const requiredProviders = (
    options.requiredProviders ?? parseRequiredProviders(request)
  ).filter((provider) => !isOpenTofuBuiltinProviderSource(provider));
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
  const scan = await requiredProviderSourcesFromTerraformTree(rootDir);
  if (!scan.complete || scan.files.length === 0 || scan.providers.length > 0) {
    return false;
  }
  for (const file of scan.files) {
    // The canonical graph derives package identities from HCL resource, data,
    // ephemeral, and provider-function usage. This supplemental gate rejects
    // runtime configuration that has no package projection but is not the
    // builtin-only/provider-free case this policy exception represents.
    // Until JSON compatibility semantics are fully classified, JSON remains
    // conservative even when its provider package projection is empty.
    if (openTofuConfigurationFileKind(file.path) === "json") return false;
    if (hasUnprojectedProviderRuntimeConfiguration(file.text)) return false;
  }
  return true;
}

function hasUnprojectedProviderRuntimeConfiguration(text: string): boolean {
  // A complete canonical graph with zero package projections proves every
  // required_providers entry is an OpenTofu builtin. Provider configuration
  // and backend blocks remain separate runtime authority and stay excluded
  // from the provider-free policy exception.
  return /\bprovider\s+"|\bbackend\s+"/u.test(text);
}

/**
 * Single-file compatibility helper retained for callers outside the tree
 * scanner. The canonical compiler distinguishes installable provider use from
 * builtin resource, data-source, and declared provider-function capability.
 */
export function hasProviderUsageBeforeInit(text: string): boolean {
  const graph = compileOpenTofuConfigurationGraph({
    files: [{ path: "providers.tf", text }],
  });
  return (
    !graph.complete ||
    graph.providerPackages.length > 0 ||
    hasUnprojectedProviderRuntimeConfiguration(text)
  );
}

export function providersFromPlanJson(planJson: string): readonly string[] {
  const parsed = JSON.parse(planJson) as JsonRecord;
  const providers = new Set<string>();
  collectProviderFullNames(parsed, providers);
  return normalizedProviderList([...providers]);
}

export function normalizedProviderList(
  providers: readonly string[],
): readonly string[] {
  return Array.from(
    new Set(
      providers
        .map(canonicalProviderAddress)
        .filter((provider) => !isOpenTofuBuiltinProviderSource(provider)),
    ),
  ).sort();
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
    readonly attestationMethod?:
      | "forced_filesystem_mirror_init"
      | "runner_observed_installed_artifact";
    readonly cliConfigDigest?: string;
    readonly installedPath?: string;
    readonly installedDigest?: string;
  }[]
> {
  const mirrorRoot =
    Bun.env.OPENTOFU_PROVIDER_MIRROR ?? DEFAULT_PROVIDER_MIRROR_PATH;
  const attestedProviders = new Set(attestation?.providers ?? []);
  const rows = await Promise.all(
    normalizedProviderList(providers).map(async (canonical) => {
      const mirrorPath = join(mirrorRoot, ...canonical.split("/"));
      const installedPath = join(
        moduleDir,
        ".terraform",
        "providers",
        ...canonical.split("/"),
      );
      const mirrored = await pathExists(mirrorPath);
      const installedDigest = await digestPathIfExists(installedPath);
      const mirrorAttested = mirrored && attestedProviders.has(canonical);
      // A direct installation has no mirror attestation to inherit. Its
      // truthful owner observation is the exact digest of the installed
      // provider tree, so mutation evidence can bind the provider source to
      // the artifact that actually ran.
      const attested = installedDigest !== undefined;
      return {
        provider: canonical,
        mirrored,
        installationMethod: mirrored ? "filesystem_mirror" : "direct",
        mirrorPath,
        ...(installedDigest ? { installedDigest } : {}),
        ...(attested
          ? {
              attested: true,
              attestationMethod: mirrorAttested
                ? ("forced_filesystem_mirror_init" as const)
                : ("runner_observed_installed_artifact" as const),
              installedPath,
              ...(mirrorAttested && attestation
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
