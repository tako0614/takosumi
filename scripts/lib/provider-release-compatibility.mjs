import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPATIBILITY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "provider",
  "release",
  "compatibility",
);
export const STATE_IDENTITY_PATH = join(
  COMPATIBILITY_ROOT,
  "1.0.0-state-identity.json",
);
export const DELTA_POLICY_PATH = join(
  COMPATIBILITY_ROOT,
  "1.1.0-delta-policy.json",
);
const REPO_ROOT = resolve(COMPATIBILITY_ROOT, "..", "..", "..");
const SHA256 = /^[a-f0-9]{64}$/;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

function structural(value) {
  if (Array.isArray(value)) return value.map(structural);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter(
        (key) =>
          key !== "description" &&
          key !== "description_kind" &&
          key !== "validators",
      )
      .sort()
      .map((key) => [key, structural(value[key])]),
  );
}

export function structuralSha256(block) {
  return digest(JSON.stringify(structural(block)));
}

function providerSchemaStructuralSha256(schema) {
  const value = clone(schema);
  for (const key of Object.keys(value)) {
    if (key.startsWith("_takosumi")) delete value[key];
  }
  return structuralSha256(value);
}

async function readAuthority(path) {
  const [bytes, sidecarBytes] = await Promise.all([
    readFile(path),
    readFile(`${path}.sha256`, "utf8"),
  ]);
  const match = /^([a-f0-9]{64})  ([^/\n]+)\n?$/.exec(sidecarBytes);
  if (!match || match[2] !== basename(path)) {
    throw new Error(`invalid compatibility digest sidecar ${path}.sha256`);
  }
  const actual = digest(bytes);
  if (match[1] !== actual) {
    throw new Error(`compatibility authority digest mismatch for ${path}`);
  }
  return { value: JSON.parse(bytes.toString("utf8")), sha256: actual };
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} fields mismatch: ${actual.join(", ")}`);
  }
}

export function validateCompatibilityAuthorities(identity, policy, digests = {}) {
  exactKeys(
    identity,
    ["schemaVersion", "kind", "provider", "capture", "addressMatrix", "stateIdentity"],
    "state identity",
  );
  if (
    identity.schemaVersion !== 1 ||
    identity.kind !== "takosumi.provider-state-identity@v1" ||
    identity.capture.containsStateValues !== false ||
    identity.capture.containsSecrets !== false
  ) {
    throw new Error("invalid or unsafe 1.0.0 state identity fixture");
  }
  if (!SHA256.test(identity.stateIdentity.providerStructuralSha256 ?? "")) {
    throw new Error("state identity requires a provider structural digest");
  }
  if (
    identity.addressMatrix.status !== "explicit-dual-address" ||
    identity.addressMatrix.openTofuSource !==
      identity.provider.openTofuAddress ||
    identity.addressMatrix.terraformSource !==
      identity.provider.terraformServeAddress ||
    identity.provider.openTofuAddress ===
      identity.provider.terraformServeAddress
  ) {
    throw new Error("provider identities must retain explicit distinct OpenTofu and Terraform FQNs");
  }
  for (const [name, resource] of Object.entries(identity.stateIdentity.resources ?? {})) {
    if (!name.startsWith("takosumi_") || !SHA256.test(resource.structuralSha256 ?? "")) {
      throw new Error(`invalid historical resource identity ${name}`);
    }
  }
  exactKeys(
    policy,
    [
      "schemaVersion",
      "kind",
      "baseline",
      "candidate",
      "additiveResources",
      "additiveAttributes",
      "additiveSchemaIdentity",
      "patchFeatureDecision",
      "stateCompatibility",
      "terraformCompatibility",
      "releaseEligibility",
    ],
    "candidate delta policy",
  );
  if (
    policy.schemaVersion !== 1 ||
    policy.kind !== "takosumi.provider-candidate-delta-policy@v1" ||
    policy.baseline.version !== identity.provider.version ||
    policy.candidate.version !== "1.1.0"
  ) {
    throw new Error("compatibility policy does not bind 1.0.0 to 1.1.0");
  }
  if (digests.identity && policy.baseline.identitySha256 !== digests.identity) {
    throw new Error("compatibility policy identity digest does not match authority");
  }
  if (policy.additiveResources.length > 0 || policy.additiveAttributes.length > 0) {
    if (
      policy.candidate.semverChange !== "minor" ||
      policy.patchFeatureDecision.admitted !== false ||
      policy.patchFeatureDecision.status !== "resolved-move-to-minor" ||
      policy.releaseEligibility !== "blocked"
    ) {
      throw new Error(
        "additive provider changes must reject the patch lane and remain a blocked minor candidate",
      );
    }
  }
  exactKeys(
    policy.additiveSchemaIdentity,
    ["normalization", "resources", "attributes", "implementationSources"],
    "additive schema identity",
  );
  if (
    policy.additiveSchemaIdentity.normalization !==
    "opentofu-structural-v1-plus-provider-source-v1"
  ) {
    throw new Error("unexpected additive schema normalization");
  }
  if (
    JSON.stringify(Object.keys(policy.additiveSchemaIdentity.resources).sort()) !==
      JSON.stringify([...policy.additiveResources].sort()) ||
    JSON.stringify(Object.keys(policy.additiveSchemaIdentity.attributes).sort()) !==
      JSON.stringify([...policy.additiveAttributes].sort())
  ) {
    throw new Error("additive schema identities must exactly cover declared additions");
  }
  for (const [name, resource] of Object.entries(
    policy.additiveSchemaIdentity.resources,
  )) {
    exactKeys(
      resource,
      ["schemaVersion", "structuralSha256"],
      `additive resource identity ${name}`,
    );
    if (
      !Number.isSafeInteger(resource.schemaVersion) ||
      !SHA256.test(resource.structuralSha256 ?? "")
    ) {
      throw new Error(`invalid additive resource identity ${name}`);
    }
  }
  for (const [path, hash] of Object.entries(
    policy.additiveSchemaIdentity.attributes,
  )) {
    if (!SHA256.test(hash ?? "")) {
      throw new Error(`invalid additive attribute identity ${path}`);
    }
  }
  const sourcePaths = new Set();
  for (const source of policy.additiveSchemaIdentity.implementationSources) {
    exactKeys(source, ["path", "sha256"], "provider implementation source");
    if (
      !/^provider\/internal\/provider\/[a-z0-9_-]+\.go$/.test(source.path ?? "") ||
      !SHA256.test(source.sha256 ?? "") ||
      sourcePaths.has(source.path)
    ) {
      throw new Error(`invalid provider implementation source ${String(source.path)}`);
    }
    sourcePaths.add(source.path);
  }
  if (sourcePaths.size === 0) {
    throw new Error("additive schema identity requires implementation source pins");
  }
  if (policy.stateCompatibility.status === "proof-complete") {
    const covered = [...policy.stateCompatibility.evidence.coveredResources].sort();
    const historical = Object.keys(identity.stateIdentity.resources).sort();
    if (
      JSON.stringify(covered) !== JSON.stringify(historical) ||
      policy.stateCompatibility.evidence.remainingResources.length !== 0
    ) {
      throw new Error("complete state compatibility evidence must cover every historical resource");
    }
  }
  exactKeys(
    policy.terraformCompatibility,
    [
      "status",
      "command",
      "openTofuAddress",
      "terraformAddress",
      "addressesTreatedAsInterchangeable",
      "releaseEvidenceStatus",
    ],
    "Terraform compatibility policy",
  );
  if (
    policy.terraformCompatibility.status !== "proof-command-implemented" ||
    policy.terraformCompatibility.openTofuAddress !==
      identity.provider.openTofuAddress ||
    policy.terraformCompatibility.terraformAddress !==
      identity.provider.terraformServeAddress ||
    policy.terraformCompatibility.addressesTreatedAsInterchangeable !== false ||
    policy.terraformCompatibility.releaseEvidenceStatus !== "proof-run-required"
  ) {
    throw new Error("invalid explicit OpenTofu/Terraform compatibility policy");
  }
  return { identity, policy };
}

export async function loadCompatibilityAuthorities() {
  const [identity, policy] = await Promise.all([
    readAuthority(STATE_IDENTITY_PATH),
    readAuthority(DELTA_POLICY_PATH),
  ]);
  return {
    ...validateCompatibilityAuthorities(identity.value, policy.value, {
      identity: identity.sha256,
    }),
    identityDigest: identity.sha256,
    policyDigest: policy.sha256,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function removeAttribute(block, path) {
  const parts = path.split(".");
  let attributes = block.attributes;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const attribute = attributes?.[parts[index]];
    attributes = attribute?.nested_type?.attributes;
    if (!attributes) return false;
  }
  const name = parts.at(-1);
  if (!attributes || !(name in attributes)) return false;
  delete attributes[name];
  return true;
}

function findAttribute(block, path) {
  const parts = path.split(".");
  let attributes = block.attributes;
  let attribute;
  for (const part of parts) {
    attribute = attributes?.[part];
    if (!attribute) return null;
    attributes = attribute.nested_type?.attributes;
  }
  return attribute;
}

export function compareCandidateSchema(providerSchema, identity, policy) {
  const failures = [];
  const provider = providerSchema.provider;
  if (!provider || provider.version !== identity.stateIdentity.providerSchemaVersion) {
    failures.push("provider schema version changed");
  } else if (structuralSha256(provider.block) !== identity.stateIdentity.providerStructuralSha256) {
    failures.push("provider schema structure changed");
  }
  const current = providerSchema.resource_schemas ?? {};
  const historical = identity.stateIdentity.resources;
  const currentNames = Object.keys(current).sort();
  const historicalNames = Object.keys(historical).sort();
  const added = currentNames.filter((name) => !historicalNames.includes(name));
  const removed = historicalNames.filter((name) => !currentNames.includes(name));
  if (JSON.stringify(added) !== JSON.stringify([...policy.additiveResources].sort())) {
    failures.push(`unclassified resource delta: added=${added.join(",")} removed=${removed.join(",")}`);
  }
  if (removed.length > 0) failures.push(`historical resources removed: ${removed.join(",")}`);

  for (const [name, expected] of Object.entries(
    policy.additiveSchemaIdentity?.resources ?? {},
  )) {
    const schema = current[name];
    if (
      !schema ||
      schema.version !== expected.schemaVersion ||
      structuralSha256(schema.block) !== expected.structuralSha256
    ) {
      failures.push(`${name} additive resource schema identity changed`);
    }
  }

  for (const [entry, expectedHash] of Object.entries(
    policy.additiveSchemaIdentity?.attributes ?? {},
  )) {
    const dot = entry.indexOf(".");
    const resource = entry.slice(0, dot);
    const path = entry.slice(dot + 1);
    const attribute = findAttribute(current[resource]?.block ?? {}, path);
    if (!attribute || structuralSha256(attribute) !== expectedHash) {
      failures.push(`${entry} additive attribute schema identity changed`);
    }
  }

  const expectedSources = policy.additiveSchemaIdentity?.implementationSources;
  if (expectedSources) {
    const currentSources = providerSchema._takosumiImplementationSources;
    if (
      !currentSources ||
      JSON.stringify(currentSources) !== JSON.stringify(expectedSources)
    ) {
      failures.push(
        "provider implementation source identity changed; defaults or validators may have drifted",
      );
    }
  }

  const additionsByResource = new Map();
  for (const entry of policy.additiveAttributes) {
    const dot = entry.indexOf(".");
    const resource = entry.slice(0, dot);
    const path = entry.slice(dot + 1);
    additionsByResource.set(resource, [...(additionsByResource.get(resource) ?? []), path]);
  }
  for (const [name, expected] of Object.entries(historical)) {
    const schema = current[name];
    if (!schema) continue;
    if (schema.version !== expected.schemaVersion) {
      failures.push(`${name} schema version changed`);
      continue;
    }
    const baseline = clone(schema.block);
    for (const path of additionsByResource.get(name) ?? []) {
      if (!removeAttribute(baseline, path)) failures.push(`${name}.${path} declared additive but absent`);
    }
    const actual = structuralSha256(baseline);
    if (actual !== expected.structuralSha256) {
      failures.push(`${name} contains an unclassified structural change`);
    }
  }
  return {
    compatible: failures.length === 0,
    failures,
    additiveResources: added,
    additiveAttributes: [...policy.additiveAttributes],
  };
}

function commandAvailable(name) {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout ?? "";
}

export async function captureCandidateSchema({ repoRoot = REPO_ROOT } = {}) {
  const authorities = await loadCompatibilityAuthorities();
  const descriptor = JSON.parse(
    await readFile(join(repoRoot, "provider", "release", "version.json"), "utf8"),
  );
  if (descriptor.version !== authorities.policy.candidate.version) {
    throw new Error("candidate descriptor version drifted from compatibility policy");
  }
  const tofu = commandAvailable("tofu");
  if (!tofu) throw new Error("OpenTofu CLI is required for provider schema compatibility");
  const root = await mkdtemp(join(tmpdir(), "takosumi-provider-compatibility-"));
  try {
    const binaryDir = join(root, "provider");
    const moduleDir = join(root, "module");
    await mkdir(binaryDir, { recursive: true });
    await mkdir(moduleDir, { recursive: true });
    const binary = join(binaryDir, `terraform-provider-takosumi_v${descriptor.version}`);
    run(
      descriptor.toolchain.go.path,
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-mod=readonly",
        "-ldflags",
        `-buildid= -X main.version=${descriptor.version}`,
        "-o",
        binary,
        ".",
      ],
      {
        cwd: join(repoRoot, "provider"),
        env: { ...process.env, CGO_ENABLED: "0", GOCACHE: join(root, "gocache") },
      },
    );
    await chmod(binary, 0o755);
    await Bun.write(
      join(root, "tofurc"),
      `provider_installation {\n  dev_overrides {\n    "${identityAddress(authorities.identity)}" = "${binaryDir}"\n  }\n  direct {}\n}\n`,
    );
    await Bun.write(
      join(moduleDir, "main.tf"),
      `terraform {\n  required_providers {\n    takosumi = {\n      source = "${identityAddress(authorities.identity)}"\n    }\n  }\n}\n`,
    );
    const env = {
      ...process.env,
      TF_CLI_CONFIG_FILE: join(root, "tofurc"),
      TF_DATA_DIR: join(root, "tofu-data"),
      TF_IN_AUTOMATION: "1",
      CHECKPOINT_DISABLE: "1",
    };
    const schema = JSON.parse(
      run(tofu, ["providers", "schema", "-json"], { cwd: moduleDir, env }),
    );
    const providerSchema = schema.provider_schemas?.[
      identityAddress(authorities.identity)
    ];
    if (!providerSchema) {
      throw new Error("OpenTofu omitted the current provider schema");
    }
    providerSchema._takosumiImplementationSources = await Promise.all(
      authorities.policy.additiveSchemaIdentity.implementationSources.map(
        async (source) => ({
          path: source.path,
          sha256: digest(await readFile(join(repoRoot, source.path))),
        }),
      ),
    );
    const terraform = commandAvailable("terraform");
    if (terraform) {
      const terraformModuleDir = join(root, "terraform-module");
      const terraformConfig = join(root, "terraformrc");
      await mkdir(terraformModuleDir, { recursive: true });
      await Bun.write(
        terraformConfig,
        `provider_installation {\n  dev_overrides {\n    "${authorities.identity.provider.terraformServeAddress}" = "${binaryDir}"\n  }\n  direct {}\n}\n`,
      );
      await Bun.write(
        join(terraformModuleDir, "main.tf"),
        `terraform {\n  required_providers {\n    takosumi = {\n      source = "${authorities.identity.provider.terraformServeAddress}"\n    }\n  }\n}\n`,
      );
      const terraformEnvironment = {
        ...process.env,
        TF_CLI_CONFIG_FILE: terraformConfig,
        TF_DATA_DIR: join(root, "terraform-data"),
        TF_IN_AUTOMATION: "1",
        CHECKPOINT_DISABLE: "1",
      };
      const terraformSchemaDocument = JSON.parse(
        run(terraform, ["providers", "schema", "-json"], {
          cwd: terraformModuleDir,
          env: terraformEnvironment,
        }),
      );
      const terraformSchema = terraformSchemaDocument.provider_schemas?.[
        authorities.identity.provider.terraformServeAddress
      ];
      if (!terraformSchema) {
        throw new Error("Terraform omitted the explicit Terraform provider FQN");
      }
      const openTofuHash = providerSchemaStructuralSha256(providerSchema);
      const terraformHash = providerSchemaStructuralSha256(terraformSchema);
      if (openTofuHash !== terraformHash) {
        throw new Error("OpenTofu and Terraform exposed different candidate schemas");
      }
      providerSchema._takosumiTerraformSchemaProof = {
        cliPath: terraform,
        openTofuAddress: authorities.identity.provider.openTofuAddress,
        terraformAddress: authorities.identity.provider.terraformServeAddress,
        openTofuStructuralSha256: openTofuHash,
        terraformStructuralSha256: terraformHash,
        addressesTreatedAsInterchangeable: false,
      };
    }
    return providerSchema;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function identityAddress(identity) {
  return identity.provider.openTofuAddress;
}

export function providerCliPrerequisites(identity, available = {}) {
  const tofuPath = Object.hasOwn(available, "tofu")
    ? available.tofu
    : commandAvailable("tofu");
  const terraformPath = Object.hasOwn(available, "terraform")
    ? available.terraform
    : commandAvailable("terraform");
  return {
    openTofu: tofuPath
      ? { status: "ready", path: tofuPath }
      : { status: "blocked-prerequisite", reason: "opentofu-cli-unavailable", releaseBlocking: true },
    terraform: terraformPath
      ? { status: "ready", path: terraformPath }
      : { status: "blocked-prerequisite", reason: "terraform-cli-unavailable", releaseBlocking: true },
    terraformMatrix: {
      status: "proof-command-required",
      reason: "terraform-schema-state-and-fqn-proof-command-required",
      releaseBlocking: true,
    },
    addressMatrix: {
      status: "explicit-dual-address-proof-required",
      openTofuSource: identity.provider.openTofuAddress,
      terraformServeAddress: identity.provider.terraformServeAddress,
      hostedMirrorAddresses: identity.addressMatrix.hostedMirrorAddresses,
      addressesTreatedAsInterchangeable: false,
      releaseBlocking: true,
    },
  };
}

export async function verifyProviderCompatibility({ providerSchema } = {}) {
  const authorities = await loadCompatibilityAuthorities();
  const schema = providerSchema ?? (await captureCandidateSchema());
  const schemaCompatibility = compareCandidateSchema(
    schema,
    authorities.identity,
    authorities.policy,
  );
  if (!schemaCompatibility.compatible) {
    throw new Error(schemaCompatibility.failures.join("; "));
  }
  const prerequisites = providerCliPrerequisites(authorities.identity);
  if (schema._takosumiTerraformSchemaProof) {
    prerequisites.terraformMatrix = {
      status: "schema-proven-state-proof-command-required",
      reason: "terraform-state-and-fqn-proof-command-required",
      schemaProof: schema._takosumiTerraformSchemaProof,
      releaseBlocking: true,
    };
    prerequisites.addressMatrix.status =
      "explicit-dual-address-schema-proven-state-pending";
  }
  const blockers = [];
  if (prerequisites.terraform.status !== "ready") blockers.push("terraform-cli-unavailable");
  blockers.push("terraform-schema-state-and-fqn-proof-command-required");
  return {
    kind: "takosumi.provider-compatibility-verification@v1",
    baselineVersion: authorities.identity.provider.version,
    candidateVersion: authorities.policy.candidate.version,
    identityDigest: authorities.identityDigest,
    policyDigest: authorities.policyDigest,
    schemaCompatibility,
    prerequisites,
    patchFeatureDecision: authorities.policy.patchFeatureDecision,
    stateCompatibility: authorities.policy.stateCompatibility,
    terraformCompatibility: authorities.policy.terraformCompatibility,
    releaseReady: false,
    blockers,
  };
}

export async function requireProviderCompatibilityReleaseReady(options = {}) {
  const result = await verifyProviderCompatibility(options);
  if (!result.releaseReady) {
    throw new Error(`provider compatibility release blocked: ${result.blockers.join(", ")}`);
  }
  return result;
}
