import type {
  CapsuleCompatibilityLevel,
  CapsuleDataSourceSummary,
  CapsuleGateFinding,
  CapsuleProviderRequirement,
  CapsuleProvisionerSummary,
  CapsuleResourceSummary,
  CapsuleRootModuleOutputDeclaration,
  CapsuleRootModuleVariableDeclaration,
} from "takosumi-contract/capsules";
import type { PolicyConfig } from "takosumi-contract/install-configs";
import { canonicalProviderSource } from "takosumi-contract/provider-env-rules";
import type { SourceSnapshot } from "takosumi-contract/sources";
import {
  compileOpenTofuConfigurationGraph,
  openTofuConfigurationFileKind,
  parseOpenTofuProviderLockObservation,
  type OpenTofuConfigurationDiagnostic,
} from "takosumi-opentofu-configuration";

export interface CapsuleSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface CapsuleCompatibilityAnalysisInput {
  readonly sourceId: string;
  readonly sourceSnapshot: SourceSnapshot;
  readonly files: readonly CapsuleSourceFile[];
  readonly policy?: PolicyConfig;
}

export interface CapsuleCompatibilityAnalysis {
  readonly level: CapsuleCompatibilityLevel;
  readonly findings: readonly CapsuleGateFinding[];
  readonly providers: readonly CapsuleProviderRequirement[];
  readonly resources: readonly CapsuleResourceSummary[];
  readonly dataSources: readonly CapsuleDataSourceSummary[];
  readonly provisioners: readonly CapsuleProvisionerSummary[];
  readonly rootModuleVariables: readonly string[];
  readonly rootModuleVariableDeclarations: readonly CapsuleRootModuleVariableDeclaration[];
  readonly rootModuleOutputs: readonly CapsuleRootModuleOutputDeclaration[];
}

export interface CapsuleCompatibilityAnalyzer {
  analyze(
    input: CapsuleCompatibilityAnalysisInput,
  ): Promise<CapsuleCompatibilityAnalysis>;
}

/**
 * `undefined` means that the operator did not configure a type allowlist.
 * This is intentionally different from an empty set, which denies every type.
 * Core must not smuggle a vendor catalog into the meaning of "unset".
 */
type ExplicitAllowlist = ReadonlySet<string> | undefined;

const CREDENTIAL_PROVIDER_ATTRIBUTES = new Set([
  "access_key",
  "secret_key",
  "token",
  "api_key",
  "api_token",
  "client_secret",
  "password",
]);

export class StaticHclCapsuleCompatibilityAnalyzer implements CapsuleCompatibilityAnalyzer {
  async analyze(
    input: CapsuleCompatibilityAnalysisInput,
  ): Promise<CapsuleCompatibilityAnalysis> {
    return analyzeOpenTofuCapsuleFiles(input);
  }
}

export function analyzeOpenTofuCapsuleFiles(
  input: CapsuleCompatibilityAnalysisInput,
): CapsuleCompatibilityAnalysis {
  const findings: CapsuleGateFinding[] = [];
  if (input.files.length === 0) {
    return {
      level: "needs_patch",
      findings: [
        {
          severity: "warning",
          compatibilityImpact: "needs_patch",
          code: "capsule_source_files_unavailable",
          message:
            "Capsule source files are unavailable to the compatibility analyzer; runner-backed archive expansion is required for full Gate findings.",
          path: input.sourceSnapshot.path,
          suggestion:
            "Run compatibility_check through the Runner Container so the SourceSnapshot archive can be inspected before provider credential mint.",
        },
      ],
      providers: [],
      resources: [],
      dataSources: [],
      provisioners: [],
      rootModuleVariables: [],
      rootModuleVariableDeclarations: [],
      rootModuleOutputs: [],
    };
  }

  const configuration = compileOpenTofuConfigurationGraph({
    files: input.files,
  });
  collectOpenTofuConfigurationDiagnostics(configuration.diagnostics, findings);
  const hclFiles = configuration.files.filter(
    (file) => openTofuConfigurationFileKind(file.path) === "hcl",
  );
  const rootModuleOutputs = collectRootModuleOutputDeclarations(hclFiles);
  for (const output of rootModuleOutputs) {
    if (output.sensitive === null || output.ephemeral === null) {
      findings.push({
        severity: "error",
        compatibilityImpact: "unsupported",
        code: "output_metadata_expression_unsupported",
        message:
          `Root module Output ${output.name} uses a non-literal sensitive or ` +
          "ephemeral expression that compatibility analysis cannot preserve safely.",
        suggestion:
          "Use literal true/false Output metadata so a generated root can preserve it exactly.",
      });
      continue;
    }
    if (!output.ephemeral) continue;
    findings.push({
      severity: "error",
      compatibilityImpact: "unsupported",
      code: "ephemeral_root_output_unsupported",
      message:
        `Root module Output ${output.name} is ephemeral and cannot be persisted ` +
        "or re-exported by a generated OpenTofu root.",
      suggestion:
        "Keep transient values inside the module or expose a separate non-ephemeral Output intended for the Capsule ledger.",
    });
  }

  const providerAllowlist = allowedProviderSet(input.policy);
  const credentialRequiredProviders = explicitProviderSet(
    input.policy?.providerCredentials?.requiredProviders,
  );
  const resourceAllowlist = explicitAllowlist(
    input.policy?.allowedResourceTypes,
  );
  const dataSourceAllowlist = explicitAllowlist(
    input.policy?.allowedDataSourceTypes,
  );
  // Provisioners execute arbitrary processes. Unlike provider/resource/data
  // type policy, absence is therefore a deliberate deny-by-default boundary.
  const provisionerAllowlist = new Set(
    input.policy?.allowedProvisionerTypes ?? [],
  );
  const providers = configuration.requirements.map((requirement) => ({
    ...requirement,
    allowed: providerAllowed(requirement.source, providerAllowlist),
    ...(credentialRequiredProviders.has("*") ||
    providerInSet(requirement.source, credentialRequiredProviders)
      ? { credentialRequired: true }
      : {}),
  }));
  collectHclConfigurationFindings(hclFiles, findings);
  const resources = collectResources(hclFiles, resourceAllowlist);
  const dataSources = collectDataSources(hclFiles, dataSourceAllowlist);
  const provisioners = collectProvisioners(hclFiles, provisionerAllowlist);
  collectDependencyLockFindings(input.files, providers, findings);
  collectFilesystemSensitiveExpressionFindings(hclFiles, findings);

  const hasProviderBackedBlocks =
    resources.length > 0 || dataSources.length > 0 || provisioners.length > 0;
  if (providers.length === 0 && hasProviderBackedBlocks) {
    findings.push({
      severity: "warning",
      compatibilityImpact: "needs_patch",
      code: "required_providers_missing",
      message: "No required_providers block was detected.",
      suggestion:
        "Declare required_providers so Takosumi can pin provider source addresses before credential mint.",
    });
  }

  if (!hasOutputBlock(hclFiles)) {
    findings.push({
      severity: "warning",
      compatibilityImpact: "needs_patch",
      code: "outputs_missing",
      message: "No output blocks were detected.",
      suggestion:
        "Expose at least the public or dependency outputs expected by the InstallConfig outputAllowlist.",
    });
  }

  for (const provider of providers) {
    if (!provider.allowed) {
      findings.push({
        severity: "error",
        compatibilityImpact: "unsupported",
        code: "provider_not_allowed",
        message: `Provider ${provider.source} is not allowed by policy.`,
        suggestion:
          "Use a qualified provider source such as namespace/name or registry-host/namespace/name.",
      });
    }
  }
  for (const resource of resources) {
    if (!resource.allowed) {
      findings.push({
        severity: "error",
        compatibilityImpact: "unsupported",
        code: "resource_type_not_allowed",
        message: `Resource type ${resource.type} is not allowed by policy.`,
        suggestion:
          "Use an allowed resource type or update the Workspace/InstallConfig resource policy.",
      });
    }
  }
  for (const dataSource of dataSources) {
    if (!dataSource.allowed) {
      findings.push({
        severity: dataSource.type === "external" ? "error" : "warning",
        compatibilityImpact:
          dataSource.type === "external" ? "unsupported" : "needs_patch",
        code:
          dataSource.type === "external"
            ? "external_data_source_unsupported"
            : "data_source_not_allowed",
        message: `Data source ${dataSource.type} is not allowed by policy.`,
      });
    }
  }
  for (const provisioner of provisioners) {
    if (!provisioner.allowed) {
      findings.push({
        severity: "error",
        compatibilityImpact: "unsupported",
        code: "provisioner_unsupported",
        message: `Provisioner ${provisioner.type} is not supported for one-touch Capsule execution.`,
        suggestion:
          "Remove provisioners or move imperative setup behind an audited build/deploy adapter.",
      });
    }
  }

  const level = compatibilityLevel(findings);
  return {
    level,
    findings,
    providers,
    resources,
    dataSources,
    provisioners,
    rootModuleVariables: collectRootModuleVariableNames(hclFiles),
    rootModuleVariableDeclarations:
      collectRootModuleVariableDeclarations(hclFiles),
    rootModuleOutputs,
  };
}

function collectOpenTofuConfigurationDiagnostics(
  diagnostics: readonly OpenTofuConfigurationDiagnostic[],
  findings: CapsuleGateFinding[],
): void {
  for (const diagnostic of diagnostics) {
    const code =
      diagnostic.code === "configuration_missing"
        ? "opentofu_configuration_missing"
        : diagnostic.code === "json_invalid"
          ? "opentofu_json_invalid"
          : diagnostic.code === "json_semantics_unsupported"
            ? "opentofu_json_semantics_unsupported"
            : diagnostic.code === "local_module_source_escapes"
              ? "local_module_source_escapes_capsule"
              : diagnostic.code === "local_module_source_missing"
                ? "local_module_source_missing"
                : `opentofu_configuration_${diagnostic.code}`;
    findings.push({
      severity: "error",
      compatibilityImpact: "unsupported",
      code,
      message: diagnostic.message,
      path: diagnostic.path,
      suggestion:
        diagnostic.code === "json_semantics_unsupported"
          ? "Use equivalent HCL until compatibility classification covers all OpenTofu JSON block semantics."
          : "Make the selected OpenTofu module and every reachable local child statically readable before compatibility review.",
    });
  }
}

function collectHclConfigurationFindings(
  files: readonly CapsuleSourceFile[],
  findings: CapsuleGateFinding[],
): void {
  for (const file of files) {
    for (const providerBlock of matchNamedBlocks(file.text, "provider")) {
      if (containsCredentialAttribute(providerBlock.body)) {
        findings.push({
          severity: "warning",
          compatibilityImpact: "needs_patch",
          code: "provider_credentials_in_source",
          message: `Provider ${providerBlock.name} contains credential-like attributes.`,
          path: file.path,
          context: { provider: providerBlock.name },
          suggestion:
            "Remove provider credentials from HCL and deliver them at Run time through a Provider Connection and Credential Recipe.",
        });
      }
      if (providerBlock.body.trim().length > 0) {
        findings.push({
          severity: "info",
          compatibilityImpact: "none",
          code: "provider_configuration_preserved",
          message: `Provider ${providerBlock.name} configuration remains part of the repository module.`,
          path: file.path,
          context: { provider: providerBlock.name },
          suggestion:
            "Keep non-secret provider configuration in the module; deliver secret material through a Provider Connection.",
        });
      }
    }
    for (const backend of matchNamedBlocks(file.text, "backend")) {
      findings.push({
        severity: "info",
        compatibilityImpact: "none",
        code: "backend_state_isolated",
        message: `Backend ${backend.name} is not rewritten; Takosumi owns the Run state boundary outside the repository configuration.`,
        path: file.path,
      });
    }
    for (const moduleBlock of matchNamedBlocks(file.text, "module")) {
      const source = stringAttribute(moduleBlock.body, "source");
      if (source && isUnpinnedRemoteModule(source)) {
        findings.push({
          severity: "warning",
          compatibilityImpact: "needs_patch",
          code: "remote_module_unpinned",
          message: `Module ${moduleBlock.name} uses an unpinned remote source.`,
          path: file.path,
          suggestion:
            "Pin remote module sources with an immutable ref or vendor the dependency.",
        });
      }
    }
  }
}

function collectResources(
  files: readonly CapsuleSourceFile[],
  allowedResources: ExplicitAllowlist,
): CapsuleResourceSummary[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    for (const resource of matchNamedBlocks(file.text, "resource")) {
      counts.set(resource.name, (counts.get(resource.name) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([type, count]) => ({
      type,
      count,
      allowed: resourceTypeAllowed(type, allowedResources),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function collectDataSources(
  files: readonly CapsuleSourceFile[],
  allowedDataSources: ExplicitAllowlist,
): CapsuleDataSourceSummary[] {
  const types = new Set<string>();
  for (const file of files) {
    for (const dataSource of matchNamedBlocks(file.text, "data")) {
      types.add(dataSource.name);
    }
  }
  return Array.from(types)
    .map((type) => ({
      type,
      // external executes a local program and stays deny-by-default. Ordinary
      // provider data sources use the generic OpenTofu path unless an operator
      // supplied an explicit allowlist.
      allowed:
        allowedDataSources === undefined
          ? type !== "external"
          : allowlistContains(allowedDataSources, type),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function collectProvisioners(
  files: readonly CapsuleSourceFile[],
  allowedProvisioners: ReadonlySet<string>,
): CapsuleProvisionerSummary[] {
  const types = new Set<string>();
  for (const file of files) {
    for (const provisioner of matchNamedBlocks(file.text, "provisioner")) {
      types.add(provisioner.name);
    }
  }
  return Array.from(types)
    .map((type) => ({ type, allowed: allowedProvisioners.has(type) }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function collectDependencyLockFindings(
  files: readonly CapsuleSourceFile[],
  providers: readonly CapsuleProviderRequirement[],
  findings: CapsuleGateFinding[],
): void {
  const lock = files.find((file) => file.path === ".terraform.lock.hcl");
  if (!lock) return;
  findings.push({
    severity: "info",
    compatibilityImpact: "none",
    code: "dependency_lock_detected",
    message:
      "A provider dependency lockfile is present and will be reviewed by the provider lockfile policy after credential-free init.",
    path: lock.path,
  });
  const staticallyDerived = Array.from(
    new Set(providers.map((provider) => canonicalProviderSource(provider.source))),
  ).sort(compareCodePoints);
  const observation = parseOpenTofuProviderLockObservation(
    lock.text,
    lock.path,
  );
  if (!observation.complete) {
    findings.push({
      severity: "error",
      compatibilityImpact: "unsupported",
      code: "dependency_lock_incomplete",
      message: observation.diagnostics[0]?.message ??
        "The dependency lock could not be parsed exactly.",
      path: lock.path,
      suggestion:
        "Rerun credential-free OpenTofu init and review the newly generated dependency lock before Plan.",
    });
    return;
  }
  const observed = observation.sources;
  if (
    observed.length !== staticallyDerived.length ||
    observed.some((provider, index) => provider !== staticallyDerived[index])
  ) {
    findings.push({
      severity: "error",
      compatibilityImpact: "unsupported",
      code: "provider_observation_mismatch",
      message:
        "The credential-free init dependency lock provider set does not exactly match the statically derived selected-module provider set.",
      path: lock.path,
      suggestion:
        "Declare every provider required by the selected and reachable local module graph, then rerun compatibility review before Plan.",
    });
  }
}

const MODULE_LOCAL_FILESYSTEM_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly label: string;
}[] = [
  { pattern: /\bfile\s*\(/, label: "file()" },
  { pattern: /\bfileset\s*\(/, label: "fileset()" },
  { pattern: /\bfilesha256\s*\(/, label: "filesha256()" },
  { pattern: /\btemplatefile\s*\(/, label: "templatefile()" },
  { pattern: /\bpath\.module\b/, label: "path.module" },
];

const HOST_FILESYSTEM_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly label: string;
}[] = [
  { pattern: /\babspath\s*\(/, label: "abspath()" },
  { pattern: /\bpathexpand\s*\(/, label: "pathexpand()" },
  { pattern: /\bpath\.root\b/, label: "path.root" },
];

/**
 * OpenTofu's file-reading builtins take the path to read as their first
 * argument. A module-local `file()` is harmless, but the same call reaches
 * anywhere the runner process can read: the run root holds every other run's
 * workspace and the materialized provider credential files, so
 * `file("/etc/passwd")`, `templatefile("/proc/self/environ", {})`, and a
 * `fileset("/tmp/takosumi-runs", …)` state sweep are host reads that the
 * module-local warning alone let through as `ready`.
 */
const FILE_READ_CALL_PATH_LITERAL_PATTERN =
  /\b(file|fileexists|fileset|filebase64|filebase64sha256|filebase64sha512|filemd5|filesha1|filesha256|filesha512|templatefile)\s*\(\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * A path literal escapes the module when it is rooted at the host filesystem
 * (`/`), expands to the runner's home (`~`), or walks out of the module with a
 * `..` segment — including after an interpolation such as
 * `"${path.module}/../../../etc/passwd"`.
 */
function escapesModuleFilesystem(literal: string): boolean {
  if (literal.startsWith("/") || literal.startsWith("~")) return true;
  return literal.split("/").includes("..");
}

function collectHostPathLiterals(text: string): string[] {
  const literals = new Set<string>();
  for (const match of text.matchAll(FILE_READ_CALL_PATH_LITERAL_PATTERN)) {
    const literal = match[2] ?? "";
    if (escapesModuleFilesystem(literal)) {
      literals.add(`${match[1]}("${literal}")`);
    }
  }
  return [...literals];
}

function collectFilesystemSensitiveExpressionFindings(
  files: readonly CapsuleSourceFile[],
  findings: CapsuleGateFinding[],
): void {
  for (const file of files) {
    const moduleLocalHits = MODULE_LOCAL_FILESYSTEM_PATTERNS.filter((entry) =>
      entry.pattern.test(file.text),
    );
    if (moduleLocalHits.length > 0) {
      findings.push({
        severity: "warning",
        compatibilityImpact: "none",
        code: "filesystem_sensitive_expression",
        message: `Module-local OpenTofu filesystem expressions were detected: ${moduleLocalHits
          .map((hit) => hit.label)
          .join(", ")}.`,
        path: file.path,
        suggestion:
          "Keep artifact paths explicit and confined to files shipped inside the repository module.",
      });
    }

    const hostHits = [
      ...HOST_FILESYSTEM_PATTERNS.filter((entry) =>
        entry.pattern.test(file.text),
      ).map((entry) => entry.label),
      ...collectHostPathLiterals(file.text),
    ];
    if (hostHits.length > 0) {
      findings.push({
        severity: "warning",
        compatibilityImpact: "needs_patch",
        code: "filesystem_host_path_expression",
        message: `Host-path-sensitive OpenTofu expressions were detected: ${hostHits.join(
          ", ",
        )}.`,
        path: file.path,
        suggestion:
          "Avoid host-path expansion in reusable Capsules; pass explicit files through the module source or variables.",
      });
    }
  }
}

function compatibilityLevel(
  findings: readonly CapsuleGateFinding[],
): CapsuleCompatibilityLevel {
  if (
    findings.some((finding) => finding.compatibilityImpact === "unsupported")
  ) {
    return "unsupported";
  }
  if (
    findings.some((finding) => finding.compatibilityImpact === "needs_patch")
  ) {
    return "needs_patch";
  }
  return "ready";
}

function hasOutputBlock(files: readonly CapsuleSourceFile[]): boolean {
  return files.some((file) => matchNamedBlocks(file.text, "output").length > 0);
}

export function collectRootModuleVariableNames(
  files: readonly CapsuleSourceFile[],
): readonly string[] {
  return collectRootModuleNamedBlocks(files, "variable");
}

export function collectRootModuleVariableDeclarations(
  files: readonly CapsuleSourceFile[],
): readonly CapsuleRootModuleVariableDeclaration[] {
  const byName = new Map<string, CapsuleRootModuleVariableDeclaration>();
  for (const file of files) {
    if (!isRootModuleTfFile(file.path)) continue;
    for (const block of matchNamedBlocks(file.text, "variable")) {
      byName.set(block.name, {
        name: block.name,
        type: rootModuleVariableBasicType(block.body),
        hasDefault: rootModuleVariableHasDefault(block.body),
      });
    }
  }
  return Array.from(byName.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function rootModuleVariableBasicType(
  blockBody: string,
): CapsuleRootModuleVariableDeclaration["type"] {
  const masked = maskHclCommentsAndHeredocs(blockBody);
  const match = /^\s*type\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/mu.exec(masked);
  if (!match) return "unknown";
  switch (match[1]) {
    case "string":
    case "number":
    case "bool":
      return match[1] === "bool" ? "boolean" : match[1];
    case "any":
    case "list":
    case "map":
    case "object":
    case "set":
    case "tuple":
      return "json";
    default:
      return "unknown";
  }
}

function rootModuleVariableHasDefault(blockBody: string): boolean {
  return /^\s*default\s*=/mu.test(maskHclCommentsAndHeredocs(blockBody));
}

export function collectRootModuleOutputNames(
  files: readonly CapsuleSourceFile[],
): readonly string[] {
  return collectRootModuleOutputDeclarations(files).map(
    (output) => output.name,
  );
}

export function collectRootModuleOutputDeclarations(
  files: readonly CapsuleSourceFile[],
): readonly CapsuleRootModuleOutputDeclaration[] {
  const byName = new Map<string, CapsuleRootModuleOutputDeclaration>();
  for (const file of files) {
    if (!isRootModuleTfFile(file.path)) continue;
    for (const block of matchNamedBlocks(file.text, "output")) {
      byName.set(block.name, {
        name: block.name,
        sensitive: literalBooleanAttribute(block.body, "sensitive"),
        ephemeral: literalBooleanAttribute(block.body, "ephemeral"),
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

function literalBooleanAttribute(
  blockBody: string,
  attribute: "sensitive" | "ephemeral",
): boolean | null {
  const assignment = new RegExp(`^\\s*${attribute}\\s*=`, "imu");
  if (!assignment.test(blockBody)) return false;
  const literal = new RegExp(
    `^\\s*${attribute}\\s*=\\s*(true|false)\\s*(?:(?:#|//).*)?$`,
    "imu",
  ).exec(blockBody);
  if (!literal) return null;
  return literal[1] === "true";
}

function collectRootModuleNamedBlocks(
  files: readonly CapsuleSourceFile[],
  blockType: "variable" | "output",
): readonly string[] {
  const names = new Set<string>();
  for (const file of files) {
    if (!isRootModuleTfFile(file.path)) continue;
    for (const block of matchNamedBlocks(file.text, blockType)) {
      names.add(block.name);
    }
  }
  return Array.from(names).sort();
}

function isRootModuleTfFile(path: string): boolean {
  return (
    (path.endsWith(".tf") || path.endsWith(".tofu")) && !path.includes("/")
  );
}

function providerAllowed(
  source: string,
  allowedProviders: ExplicitAllowlist,
): boolean {
  if (!isQualifiedProviderSource(source)) return false;
  return allowlistContains(allowedProviders, source, providerInSet);
}

function providerInSet(
  source: string,
  providers: ReadonlySet<string>,
): boolean {
  const normalized = canonicalProviderSource(source);
  return providers.has(source) || providers.has(normalized);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isQualifiedProviderSource(source: string): boolean {
  const parts = source.trim().split("/");
  if (parts.length === 2) {
    return parts.every((part) => /^[a-z0-9][a-z0-9_-]*$/i.test(part));
  }
  return (
    parts.length === 3 &&
    /^[a-z0-9][a-z0-9.-]*$/i.test(parts[0] ?? "") &&
    parts.slice(1).every((part) => /^[a-z0-9][a-z0-9_-]*$/i.test(part))
  );
}

function resourceTypeAllowed(
  type: string,
  allowedResources: ExplicitAllowlist,
): boolean {
  return allowlistContains(allowedResources, type);
}

function explicitAllowlist(
  configured: readonly string[] | undefined,
): ExplicitAllowlist {
  return configured === undefined ? undefined : new Set(configured);
}

function allowlistContains(
  allowlist: ExplicitAllowlist,
  value: string,
  contains: (value: string, allowlist: ReadonlySet<string>) => boolean = (
    candidate,
    entries,
  ) => entries.has(candidate),
): boolean {
  return (
    allowlist === undefined || allowlist.has("*") || contains(value, allowlist)
  );
}

function allowedProviderSet(
  policy: PolicyConfig | undefined,
): ExplicitAllowlist {
  if (policy?.allowedProviders === undefined) return undefined;
  const providers = new Set<string>();
  for (const provider of policy.allowedProviders) {
    if (provider === "*") {
      providers.add(provider);
      continue;
    }
    providers.add(provider);
    providers.add(canonicalProviderSource(provider));
  }
  return providers;
}

function explicitProviderSet(
  configured: readonly string[] | undefined,
): ReadonlySet<string> {
  const providers = new Set<string>();
  for (const provider of configured ?? []) {
    providers.add(provider);
    providers.add(canonicalProviderSource(provider));
  }
  return providers;
}

function containsCredentialAttribute(body: string): boolean {
  for (const attr of CREDENTIAL_PROVIDER_ATTRIBUTES) {
    const pattern = new RegExp(`(^|\\n)\\s*${attr}\\s*=`, "m");
    if (pattern.test(body)) return true;
  }
  return false;
}

function stringAttribute(body: string, name: string): string | undefined {
  const pattern = new RegExp(`(^|\\n)\\s*${name}\\s*=\\s*"([^"]+)"`, "m");
  return pattern.exec(body)?.[2];
}

function isUnpinnedRemoteModule(source: string): boolean {
  if (source.startsWith("./") || source.startsWith("../")) return false;
  if (source.startsWith("git::")) return !source.includes("?ref=");
  if (/^https?:\/\//.test(source)) return !source.includes("?ref=");
  return false;
}

interface NamedBlock {
  readonly name: string;
  readonly body: string;
}

interface BlockRange extends NamedBlock {
  readonly start: number;
  readonly end: number;
}

// HCL comments (`#` / `//` line, `/* */` block) and heredoc bodies can carry
// brace characters and decoy keywords (e.g. a commented-out `provisioner`), so
// a naive regex + brace-counting scan can be evaded by a crafted-but-valid
// Capsule (e.g. `provisioner /* x */ "local-exec" { command = "…" }` parses as
// provisioners:[] yet runs local-exec at apply). Before any block matching we
// neutralize comment and heredoc content with an equal-length run of spaces so
// every BlockRange `start`/`end` offset stays aligned with the original text
// (consumed by removeRanges) while braces/keywords inside comments and heredocs
// no longer participate in matching or brace counting. String literals are left
// intact so attributes like `"http://x"` are never mistaken for comments.
function maskHclCommentsAndHeredocs(text: string): string {
  const out = text.split("");
  const mask = (start: number, end: number) => {
    for (let i = start; i < end && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      // Skip a double-quoted string literal (honoring backslash escapes).
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (char === "#" || (char === "/" && text[i + 1] === "/")) {
      const lineEnd = text.indexOf("\n", i);
      const end = lineEnd === -1 ? text.length : lineEnd;
      mask(i, end);
      i = end - 1;
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      mask(i, end);
      i = end - 1;
      continue;
    }
    const heredoc = /^<<-?(\w+)\r?\n/.exec(text.slice(i));
    if (heredoc) {
      const tag = heredoc[1]!;
      const bodyStart = i + heredoc[0].length;
      const terminator = new RegExp(`\\n[ \\t]*${tag}\\b`).exec(
        text.slice(bodyStart),
      );
      const bodyEnd = terminator
        ? bodyStart + terminator.index + 1
        : text.length;
      mask(bodyStart, bodyEnd);
      i = bodyEnd - 1;
      continue;
    }
  }
  return out.join("");
}

function matchNamedBlocks(text: string, blockType: string): NamedBlock[] {
  return matchNamedBlockRanges(text, blockType);
}

function matchNamedBlockRanges(text: string, blockType: string): BlockRange[] {
  const masked = maskHclCommentsAndHeredocs(text);
  const blocks: BlockRange[] = [];
  const pattern = new RegExp(
    `\\b${blockType}\\b\\s+"([^"]+)"(?:\\s+"[^"]+")?\\s*\\{`,
    "g",
  );
  for (const match of masked.matchAll(pattern)) {
    const start = match.index!;
    const block = readBlock(masked, match.index! + match[0].length - 1);
    if (block !== undefined) {
      blocks.push({ name: match[1]!, body: block.body, start, end: block.end });
    }
  }
  return blocks;
}

function readBlockBody(
  text: string,
  openBraceIndex: number,
): string | undefined {
  return readBlock(text, openBraceIndex)?.body;
}

function readBlock(
  text: string,
  openBraceIndex: number,
): { readonly body: string; readonly end: number } | undefined {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") continue;
    depth -= 1;
    if (depth === 0) {
      return { body: text.slice(openBraceIndex + 1, index), end: index + 1 };
    }
  }
  return undefined;
}
