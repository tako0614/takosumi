import type {
  CapsuleCompatibilityLevel,
  CapsuleDataSourceSummary,
  CapsuleGateFinding,
  CapsuleProviderRequirement,
  CapsuleProvisionerSummary,
  CapsuleResourceSummary,
} from "takosumi-contract/capsules";
import type { SourceSnapshot } from "takosumi-contract/sources";

export interface CapsuleSourceFile {
  readonly path: string;
  readonly text: string;
}

export interface CapsuleCompatibilityAnalysisInput {
  readonly sourceId: string;
  readonly sourceSnapshot: SourceSnapshot;
  readonly files: readonly CapsuleSourceFile[];
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

  const hclFiles = input.files.filter((file) => file.path.endsWith(".tf"));
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

  const providers = collectProviders(hclFiles, findings);
  const resources = collectResources(hclFiles);
  const dataSources = collectDataSources(hclFiles);
  const provisioners = collectProvisioners(hclFiles);

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
  return {
    level,
    findings,
    providers,
    resources,
    dataSources,
    provisioners,
    normalizedObjectKey: input.sourceSnapshot.archiveObjectKey,
    normalizedDigest: input.sourceSnapshot.archiveDigest,
  };
}

function collectProviders(
  files: readonly CapsuleSourceFile[],
  findings: CapsuleGateFinding[],
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
            "Move provider credentials to the Takosumi generated root through Connection and CapabilityBinding.",
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
      allowed: providerAllowed(source),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
}

function collectResources(
  files: readonly CapsuleSourceFile[],
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
      allowed: DEFAULT_ALLOWED_RESOURCE_TYPES.has(type),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function collectDataSources(
  files: readonly CapsuleSourceFile[],
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
      allowed: DEFAULT_ALLOWED_DATA_SOURCE_TYPES.has(type),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function collectProvisioners(
  files: readonly CapsuleSourceFile[],
): CapsuleProvisionerSummary[] {
  const types = new Set<string>();
  for (const file of files) {
    for (const provisioner of matchNamedBlocks(file.text, "provisioner")) {
      types.add(provisioner.name);
    }
  }
  return Array.from(types)
    .map((type) => ({ type, allowed: false }))
    .sort((a, b) => a.type.localeCompare(b.type));
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
          finding.code === "opentofu_configuration_missing"),
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
          finding.code === "remote_module_unpinned"),
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

function providerAllowed(source: string): boolean {
  const normalized = source.startsWith("registry.opentofu.org/")
    ? source
    : `registry.opentofu.org/${source}`;
  return (
    DEFAULT_ALLOWED_PROVIDERS.has(source) ||
    DEFAULT_ALLOWED_PROVIDERS.has(normalized)
  );
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

function matchNamedBlocks(text: string, blockType: string): NamedBlock[] {
  const blocks: NamedBlock[] = [];
  const pattern = new RegExp(
    `${blockType}\\s+"([^"]+)"(?:\\s+"[^"]+")?\\s*\\{`,
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    const body = readBlockBody(text, match.index! + match[0].length - 1);
    if (body !== undefined) {
      blocks.push({ name: match[1]!, body });
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
      return text.slice(openBraceIndex + 1, index);
    }
  }
  return undefined;
}
