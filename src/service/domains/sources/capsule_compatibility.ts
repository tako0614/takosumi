import type {
  CapsuleCompatibilityLevel,
  CapsuleDataSourceSummary,
  CapsuleGateFinding,
  CapsuleProviderRequirement,
  CapsuleProvisionerSummary,
  CapsuleResourceSummary,
} from "takosumi-contract/capsules";
import type { PolicyConfig } from "takosumi-contract/installations";
import type { SourceSnapshot } from "takosumi-contract/sources";

export interface CapsuleSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface CapsuleCompatibilityAnalysisInput {
  /** Present for git-Source snapshots; absent for upload-origin snapshots. */
  readonly sourceId?: string;
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
  readonly normalizedObjectKey?: string;
  readonly normalizedDigest?: string;
  readonly normalizedFiles?: readonly CapsuleSourceFile[];
}

export interface CapsuleCompatibilityAnalyzer {
  analyze(
    input: CapsuleCompatibilityAnalysisInput,
  ): Promise<CapsuleCompatibilityAnalysis>;
}

const DEFAULT_ALLOWED_PROVIDERS = new Set([
  "registry.opentofu.org/cloudflare/cloudflare",
  "registry.opentofu.org/hashicorp/aws",
  "registry.opentofu.org/hashicorp/random",
  "registry.opentofu.org/hashicorp/tls",
  "cloudflare/cloudflare",
  "hashicorp/aws",
  "hashicorp/random",
  "hashicorp/tls",
]);

const DEFAULT_ALLOWED_RESOURCE_TYPES = new Set([
  "cloudflare_workers_script",
  "cloudflare_workers_route",
  "cloudflare_dns_record",
  "cloudflare_r2_bucket",
  "aws_s3_bucket",
  "aws_s3_bucket_public_access_block",
  "random_id",
  "tls_private_key",
]);

const DEFAULT_ALLOWED_DATA_SOURCE_TYPES = new Set(["terraform_remote_state"]);

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
      normalizedObjectKey: input.sourceSnapshot.archiveObjectKey,
      normalizedDigest: input.sourceSnapshot.archiveDigest,
    };
  }

  const allHclFiles = input.files.filter((file) => file.path.endsWith(".tf"));
  const hclFiles = selectReachableModuleTreeFiles(allHclFiles, findings);
  if (hclFiles.length === 0) {
    findings.push({
      severity: "error",
      code: "opentofu_configuration_missing",
      message: "No .tf files were found in the Capsule path.",
      path: input.sourceSnapshot.path,
      suggestion:
        "Point the install path at an OpenTofu module-compatible configuration.",
    });
  }

  const providerAllowlist = allowedProviderSet(input.policy);
  const resourceAllowlist = allowedSet(
    DEFAULT_ALLOWED_RESOURCE_TYPES,
    input.policy?.allowedResourceTypes,
  );
  const dataSourceAllowlist = allowedSet(
    DEFAULT_ALLOWED_DATA_SOURCE_TYPES,
    input.policy?.allowedDataSourceTypes,
  );
  const provisionerAllowlist = allowedSet(
    new Set<string>(),
    input.policy?.allowedProvisionerTypes,
  );
  const providers = collectProviders(hclFiles, findings, providerAllowlist);
  const resources = collectResources(hclFiles, resourceAllowlist);
  const dataSources = collectDataSources(hclFiles, dataSourceAllowlist);
  const provisioners = collectProvisioners(hclFiles, provisionerAllowlist);
  collectDependencyLockFindings(input.files, findings);
  collectFilesystemSensitiveExpressionFindings(hclFiles, findings);

  if (providers.length === 0) {
    findings.push({
      severity: "warning",
      code: "required_providers_missing",
      message: "No required_providers block was detected.",
      suggestion:
        "Declare required_providers so Takosumi can pin provider source addresses before credential mint.",
    });
  }

  if (!hasOutputBlock(hclFiles)) {
    findings.push({
      severity: "warning",
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
        code: "provider_not_allowed",
        message: `Provider ${provider.source} is not allowed by policy.`,
        suggestion:
          "Use an allowed provider or update the Space/InstallConfig provider policy.",
      });
    }
  }
  for (const resource of resources) {
    if (!resource.allowed) {
      findings.push({
        severity: "error",
        code: "resource_type_not_allowed",
        message: `Resource type ${resource.type} is not allowed by policy.`,
        suggestion:
          "Use an allowed resource type or update the Space/InstallConfig resource policy.",
      });
    }
  }
  for (const dataSource of dataSources) {
    if (!dataSource.allowed) {
      findings.push({
        severity: dataSource.type === "external" ? "error" : "warning",
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
        code: "provisioner_unsupported",
        message: `Provisioner ${provisioner.type} is not supported for one-touch Capsule execution.`,
        suggestion:
          "Remove provisioners or move imperative setup behind an audited build/deploy adapter.",
      });
    }
  }

  const level = compatibilityLevel(findings);
  const normalizedFiles =
    level === "auto_capsulized"
      ? normalizeAutoCapsulizedFiles(input.files, hclFiles)
      : undefined;
  return {
    level,
    findings,
    providers,
    resources,
    dataSources,
    provisioners,
    normalizedObjectKey: normalizedFiles
      ? normalizedModuleObjectKey(input.sourceSnapshot)
      : input.sourceSnapshot.archiveObjectKey,
    ...(normalizedFiles
      ? {}
      : { normalizedDigest: input.sourceSnapshot.archiveDigest }),
    ...(normalizedFiles ? { normalizedFiles } : {}),
  };
}

function normalizeAutoCapsulizedFiles(
  allFiles: readonly CapsuleSourceFile[],
  hclFiles: readonly CapsuleSourceFile[],
): readonly CapsuleSourceFile[] {
  const normalizedHclFiles = hclFiles
    .map((file) => ({
      path: file.path,
      text: normalizeAutoCapsulizedHcl(file.text),
    }))
    .filter((file) => file.text.trim().length > 0);
  // Non-.tf files (migrations, schemas, templates, scripts …) are carried
  // through unchanged so the normalized module artifact stays a complete
  // Capsule, not just its rewritten HCL.
  const passthroughFiles = allFiles.filter(
    (file) => !file.path.endsWith(".tf"),
  );
  return [...normalizedHclFiles, ...passthroughFiles].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

function normalizeAutoCapsulizedHcl(text: string): string {
  const removals: BlockRange[] = [];
  for (const backend of matchNamedBlockRanges(text, "backend")) {
    removals.push(backend);
  }
  for (const provider of matchNamedBlockRanges(text, "provider")) {
    if (!containsCredentialAttribute(provider.body)) removals.push(provider);
  }
  if (removals.length === 0) return text;
  return removeRanges(text, removals)
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}

function removeRanges(text: string, ranges: readonly BlockRange[]): string {
  const merged = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const range of merged) {
    if (range.start < cursor) continue;
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  out += text.slice(cursor);
  return out;
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

function resolveLocalModuleDir(fromDir: string, source: string): string | undefined {
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

export function normalizedCapsuleArtifactBody(input: {
  readonly sourceSnapshot: SourceSnapshot;
  readonly files: readonly CapsuleSourceFile[];
}): string {
  return (
    JSON.stringify(
      {
        kind: "takosumi.normalized-capsule@v1",
        sourceSnapshotId: input.sourceSnapshot.id,
        resolvedCommit: input.sourceSnapshot.resolvedCommit,
        path: input.sourceSnapshot.path,
        files: [...input.files]
          .map((file) => ({ path: file.path, text: file.text }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2,
    ) + "\n"
  );
}

export interface NormalizedCapsuleArtifact {
  readonly kind: "takosumi.normalized-capsule@v1";
  readonly sourceSnapshotId: string;
  readonly resolvedCommit: string;
  readonly path: string;
  readonly files: readonly CapsuleSourceFile[];
}

export function parseNormalizedCapsuleArtifactBody(
  body: string,
): NormalizedCapsuleArtifact {
  const parsed: unknown = JSON.parse(body);
  if (!isPlainRecord(parsed)) {
    throw new Error("normalized capsule artifact must be a JSON object");
  }
  if (parsed.kind !== "takosumi.normalized-capsule@v1") {
    throw new Error("normalized capsule artifact kind is unsupported");
  }
  const sourceSnapshotId = stringRecordField(parsed, "sourceSnapshotId");
  const resolvedCommit = stringRecordField(parsed, "resolvedCommit");
  const path = stringRecordField(parsed, "path");
  const filesValue = parsed.files;
  if (!Array.isArray(filesValue) || filesValue.length === 0) {
    throw new Error("normalized capsule artifact files must be a non-empty array");
  }
  const files = filesValue.map((file) => {
    if (!isPlainRecord(file)) {
      throw new Error("normalized capsule artifact file must be an object");
    }
    return {
      path: stringRecordField(file, "path"),
      text: stringRecordField(file, "text"),
    };
  });
  return {
    kind: "takosumi.normalized-capsule@v1",
    sourceSnapshotId,
    resolvedCommit,
    path,
    files,
  };
}

export function normalizedModuleObjectKey(snapshot: SourceSnapshot): string {
  const base = snapshot.archiveObjectKey.replace(/\/source\.tar\.zst$/, "");
  return `${base}/normalized-module.json`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecordField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`normalized capsule artifact ${field} must be a string`);
  }
  return value;
}

function collectProviders(
  files: readonly CapsuleSourceFile[],
  findings: CapsuleGateFinding[],
  allowedProviders: ReadonlySet<string>,
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
          const source =
            stringAttribute(providerBlock.body, "source") ?? providerBlock.name;
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
          code: "provider_credentials_in_source",
          message: `Provider ${providerBlock.name} contains credential-like attributes.`,
          path: file.path,
          suggestion:
            "Move provider credentials to the Takosumi generated root through Connection and ProviderBinding.",
        });
      }
      if (providerBlock.body.trim().length > 0) {
        findings.push({
          severity: "info",
          code: "provider_block_lift_candidate",
          message: `Provider ${providerBlock.name} can be lifted into the generated root if it contains only configuration values.`,
          path: file.path,
        });
      }
    }
    for (const backend of matchNamedBlocks(file.text, "backend")) {
      findings.push({
        severity: "info",
        code: "backend_override_candidate",
        message: `Backend ${backend.name} will be replaced by Takosumi managed state.`,
        path: file.path,
      });
    }
    for (const moduleBlock of matchNamedBlocks(file.text, "module")) {
      const source = stringAttribute(moduleBlock.body, "source");
      if (source && isUnpinnedRemoteModule(source)) {
        findings.push({
          severity: "warning",
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

function canonicalProviderSource(source: string): string {
  if (source.startsWith("registry.opentofu.org/")) return source;
  if (source === "cloudflare/cloudflare") {
    return "registry.opentofu.org/cloudflare/cloudflare";
  }
  if (
    source === "hashicorp/aws" ||
    source === "hashicorp/google" ||
    source === "hashicorp/kubernetes"
  ) {
    return `registry.opentofu.org/${source}`;
  }
  if (source === "integrations/github") {
    return "registry.opentofu.org/integrations/github";
  }
  if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u.test(source)) {
    return `registry.opentofu.org/${source}`;
  }
  return source;
}

function collectResources(
  files: readonly CapsuleSourceFile[],
  allowedResources: ReadonlySet<string>,
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
      allowed: allowedResources.has(type),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function collectDataSources(
  files: readonly CapsuleSourceFile[],
  allowedDataSources: ReadonlySet<string>,
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
      allowed: allowedDataSources.has(type),
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
    code: "dependency_lock_detected",
    message:
      "A provider dependency lockfile is present and will be reviewed by the provider lockfile policy after credential-free init.",
    path: lock.path,
  });
}

const FILESYSTEM_SENSITIVE_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly label: string;
}[] = [
  { pattern: /\bfile\s*\(/, label: "file()" },
  { pattern: /\bfileset\s*\(/, label: "fileset()" },
  { pattern: /\btemplatefile\s*\(/, label: "templatefile()" },
  { pattern: /\babspath\s*\(/, label: "abspath()" },
  { pattern: /\bpathexpand\s*\(/, label: "pathexpand()" },
  { pattern: /\bpath\.root\b/, label: "path.root" },
  { pattern: /\bpath\.module\b/, label: "path.module" },
];

function collectFilesystemSensitiveExpressionFindings(
  files: readonly CapsuleSourceFile[],
  findings: CapsuleGateFinding[],
): void {
  for (const file of files) {
    const hits = FILESYSTEM_SENSITIVE_PATTERNS.filter((entry) =>
      entry.pattern.test(file.text),
    );
    if (hits.length === 0) continue;
    findings.push({
      severity: "warning",
      code: "filesystem_sensitive_expression",
      message: `Filesystem-sensitive OpenTofu expressions were detected: ${hits
        .map((hit) => hit.label)
        .join(", ")}.`,
      path: file.path,
      suggestion:
        "Keep Capsule inputs explicit as variables or ensure file reads are confined to files shipped inside the normalized module.",
    });
  }
}

function compatibilityLevel(
  findings: readonly CapsuleGateFinding[],
): CapsuleCompatibilityLevel {
  if (
    findings.some(
      (finding) =>
        finding.severity === "error" &&
        (finding.code.includes("unsupported") ||
          finding.code === "provider_not_allowed" ||
          finding.code === "resource_type_not_allowed" ||
          finding.code === "opentofu_configuration_missing" ||
          finding.code === "local_module_source_escapes_capsule"),
    )
  ) {
    return "unsupported";
  }
  if (
    findings.some(
      (finding) =>
        finding.severity === "warning" &&
        (finding.code === "required_providers_missing" ||
          finding.code === "outputs_missing" ||
          finding.code === "provider_credentials_in_source" ||
          finding.code === "filesystem_sensitive_expression" ||
          finding.code === "remote_module_unpinned" ||
          finding.code === "local_module_source_missing"),
    )
  ) {
    return "needs_patch";
  }
  if (
    findings.some(
      (finding) =>
        finding.code === "backend_override_candidate" ||
        finding.code === "provider_block_lift_candidate",
    )
  ) {
    return "auto_capsulized";
  }
  return "ready";
}

function hasOutputBlock(files: readonly CapsuleSourceFile[]): boolean {
  return files.some((file) => matchNamedBlocks(file.text, "output").length > 0);
}

function providerAllowed(
  source: string,
  allowedProviders: ReadonlySet<string>,
): boolean {
  const normalized = source.startsWith("registry.opentofu.org/")
    ? source
    : `registry.opentofu.org/${source}`;
  return allowedProviders.has(source) || allowedProviders.has(normalized);
}

function allowedSet(
  defaults: ReadonlySet<string>,
  configured: readonly string[] | undefined,
): ReadonlySet<string> {
  if (configured === undefined) return defaults;
  return new Set([...defaults, ...configured]);
}

function allowedProviderSet(policy: PolicyConfig | undefined): ReadonlySet<string> {
  if (policy?.allowedProviders === undefined) return DEFAULT_ALLOWED_PROVIDERS;
  const providers = new Set(DEFAULT_ALLOWED_PROVIDERS);
  for (const provider of policy.allowedProviders) {
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

function matchNamedBlocks(text: string, blockType: string): NamedBlock[] {
  return matchNamedBlockRanges(text, blockType);
}

function matchNamedBlockRanges(text: string, blockType: string): BlockRange[] {
  const blocks: BlockRange[] = [];
  const pattern = new RegExp(
    `${blockType}\\s+"([^"]+)"(?:\\s+"[^"]+")?\\s*\\{`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    const block = readBlock(text, match.index! + match[0].length - 1);
    if (block !== undefined) {
      blocks.push({ name: match[1]!, body: block.body, start, end: block.end });
    }
  }
  return blocks;
}

function matchBlocks(text: string, blockType: string): readonly NamedBlock[] {
  const blocks: NamedBlock[] = [];
  const pattern = new RegExp(`${blockType}\\s*\\{`, "g");
  for (const match of text.matchAll(pattern)) {
    const body = readBlockBody(text, match.index! + match[0].length - 1);
    if (body !== undefined) blocks.push({ name: blockType, body });
  }
  return blocks;
}

function matchArbitraryNamedAssignments(text: string): NamedBlock[] {
  const blocks: NamedBlock[] = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*\{/g;
  for (const match of text.matchAll(pattern)) {
    const body = readBlockBody(text, match.index! + match[0].length - 1);
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
