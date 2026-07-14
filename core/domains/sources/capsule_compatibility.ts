import type {
  CapsuleCompatibilityLevel,
  CapsuleDataSourceSummary,
  CapsuleGateFinding,
  CapsuleProviderRequirement,
  CapsuleProvisionerSummary,
  CapsuleResourceSummary,
  CapsuleRootModuleOutputDeclaration,
} from "takosumi-contract/capsules";
import type { PolicyConfig } from "takosumi-contract/install-configs";
import type { SourceSnapshot } from "takosumi-contract/sources";

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
      rootModuleOutputs: [],
    };
  }

  const allHclFiles = input.files.filter((file) => file.path.endsWith(".tf"));
  const hclFiles = selectReachableModuleTreeFiles(allHclFiles, findings);
  const rootModuleOutputs = collectRootModuleOutputDeclarations(hclFiles);
  if (hclFiles.length === 0) {
    findings.push({
      severity: "error",
      compatibilityImpact: "unsupported",
      code: "opentofu_configuration_missing",
      message: "No .tf files were found in the Capsule path.",
      path: input.sourceSnapshot.path,
      suggestion:
        "Point the install path at an OpenTofu module-compatible configuration.",
    });
  }
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
  const providers = collectProviders(hclFiles, findings, providerAllowlist);
  const resources = collectResources(hclFiles, resourceAllowlist);
  const dataSources = collectDataSources(hclFiles, dataSourceAllowlist);
  const provisioners = collectProvisioners(hclFiles, provisionerAllowlist);
  collectDependencyLockFindings(input.files, findings);
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
          "Use a fully qualified OpenTofu provider source such as namespace/name or registry.opentofu.org/namespace/name.",
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
    rootModuleOutputs,
  };
}

function selectReachableModuleTreeFiles(
  files: readonly CapsuleSourceFile[],
  findings: CapsuleGateFinding[],
): readonly CapsuleSourceFile[] {
  const byDir = new Map<string, CapsuleSourceFile[]>();
  for (const file of files) {
    const dir = dirnameForRelativeFile(file.path);
    const entries = byDir.get(dir) ?? [];
    entries.push(file);
    byDir.set(dir, entries);
  }

  const queued = ["."];
  const visited = new Set<string>();
  const selected = new Map<string, CapsuleSourceFile>();
  while (queued.length > 0) {
    const dir = queued.shift()!;
    if (visited.has(dir)) continue;
    visited.add(dir);
    const dirFiles = byDir.get(dir) ?? [];
    for (const file of dirFiles) {
      selected.set(file.path, file);
      for (const moduleBlock of matchNamedBlocks(file.text, "module")) {
        const source = stringAttribute(moduleBlock.body, "source");
        if (!source || !isLocalModuleSource(source)) continue;
        const resolved = resolveLocalModuleDir(dir, source);
        if (!resolved) {
          findings.push({
            severity: "error",
            compatibilityImpact: "unsupported",
            code: "local_module_source_escapes_capsule",
            message: `Module ${moduleBlock.name} uses local source ${source} outside the Capsule archive.`,
            path: file.path,
            suggestion:
              "Keep local module sources inside the Git path installed as the Capsule.",
          });
          continue;
        }
        if (!byDir.has(resolved)) {
          findings.push({
            severity: "warning",
            compatibilityImpact: "needs_patch",
            code: "local_module_source_missing",
            message: `Module ${moduleBlock.name} local source ${source} was not found in the Capsule archive.`,
            path: file.path,
            suggestion:
              "Vendor the local module under the installed Git path or pin it as an explicit remote module source.",
          });
          continue;
        }
        queued.push(resolved);
      }
    }
  }
  return Array.from(selected.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

function dirnameForRelativeFile(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

function isLocalModuleSource(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function resolveLocalModuleDir(
  fromDir: string,
  source: string,
): string | undefined {
  const parts = [
    ...(fromDir === "." ? [] : fromDir.split("/")),
    ...source.split("/"),
  ];
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? "." : out.join("/");
}

function collectProviders(
  files: readonly CapsuleSourceFile[],
  findings: CapsuleGateFinding[],
  allowedProviders: ExplicitAllowlist,
): CapsuleProviderRequirement[] {
  const providers = new Map<string, Set<string>>();
  for (const file of files) {
    const terraformBlocks = matchBlocks(file.text, "terraform");
    for (const block of terraformBlocks) {
      const required = matchBlocks(block.body, "required_providers");
      for (const requiredBlock of required) {
        for (const providerBlock of matchArbitraryNamedAssignments(
          requiredBlock.body,
        )) {
          // OpenTofu's source-address default for a local provider name is the
          // HashiCorp namespace. Record that real address rather than treating
          // valid OpenTofu shorthand as a Takosumi-specific provider.
          const source =
            stringAttribute(providerBlock.body, "source") ??
            `hashicorp/${providerBlock.name}`;
          const aliases = aliasesAttribute(providerBlock.body);
          const entry = providers.get(source) ?? new Set<string>();
          for (const alias of aliases) entry.add(alias);
          providers.set(source, entry);
        }
      }
    }
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
  return Array.from(providers.entries())
    .map(([source, aliases]) => ({
      source,
      aliases: Array.from(aliases).sort(),
      allowed: providerAllowed(source, allowedProviders),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
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
  findings: CapsuleGateFinding[],
): void {
  const lock = files.find((file) => file.path.endsWith(".terraform.lock.hcl"));
  if (!lock) return;
  findings.push({
    severity: "info",
    compatibilityImpact: "none",
    code: "dependency_lock_detected",
    message:
      "A provider dependency lockfile is present and will be reviewed by the provider lockfile policy after credential-free init.",
    path: lock.path,
  });
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

    const hostHits = HOST_FILESYSTEM_PATTERNS.filter((entry) =>
      entry.pattern.test(file.text),
    );
    if (hostHits.length > 0) {
      findings.push({
        severity: "warning",
        compatibilityImpact: "needs_patch",
        code: "filesystem_host_path_expression",
        message: `Host-path-sensitive OpenTofu expressions were detected: ${hostHits
          .map((hit) => hit.label)
          .join(", ")}.`,
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
    findings.some(
      (finding) => finding.compatibilityImpact === "unsupported",
    )
  ) {
    return "unsupported";
  }
  if (
    findings.some(
      (finding) => finding.compatibilityImpact === "needs_patch",
    )
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

export function collectRootModuleOutputNames(
  files: readonly CapsuleSourceFile[],
): readonly string[] {
  return collectRootModuleOutputDeclarations(files).map((output) => output.name);
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
  return path.endsWith(".tf") && !path.includes("/");
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
  const normalized = source.startsWith("registry.opentofu.org/")
    ? source
    : `registry.opentofu.org/${source}`;
  return providers.has(source) || providers.has(normalized);
}

function isQualifiedProviderSource(source: string): boolean {
  const body = source.startsWith("registry.opentofu.org/")
    ? source.slice("registry.opentofu.org/".length)
    : source;
  const parts = body.split("/");
  return (
    parts.length === 2 &&
    parts.every((part) => /^[a-z0-9][a-z0-9_-]*$/i.test(part))
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
  contains: (
    value: string,
    allowlist: ReadonlySet<string>,
  ) => boolean = (candidate, entries) => entries.has(candidate),
): boolean {
  return (
    allowlist === undefined ||
    allowlist.has("*") ||
    contains(value, allowlist)
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
    providers.add(
      provider.startsWith("registry.opentofu.org/")
        ? provider
        : `registry.opentofu.org/${provider}`,
    );
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

function aliasesAttribute(body: string): string[] {
  const match = /configuration_aliases\s*=\s*\[([\s\S]*?)\]/m.exec(body);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^"|"$/g, ""));
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

function matchBlocks(text: string, blockType: string): readonly NamedBlock[] {
  const masked = maskHclCommentsAndHeredocs(text);
  const blocks: NamedBlock[] = [];
  const pattern = new RegExp(`\\b${blockType}\\b\\s*\\{`, "g");
  for (const match of masked.matchAll(pattern)) {
    const body = readBlockBody(masked, match.index! + match[0].length - 1);
    if (body !== undefined) blocks.push({ name: blockType, body });
  }
  return blocks;
}

function matchArbitraryNamedAssignments(text: string): NamedBlock[] {
  const masked = maskHclCommentsAndHeredocs(text);
  const blocks: NamedBlock[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{/g;
  for (const match of masked.matchAll(pattern)) {
    const body = readBlockBody(masked, match.index! + match[0].length - 1);
    if (body !== undefined) {
      blocks.push({ name: match[1]!, body });
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
