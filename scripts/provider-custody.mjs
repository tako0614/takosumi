#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(ROOT, "provider", "release");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function verifySidecar(path) {
  const sidecar = await readFile(`${path}.sha256`, "utf8");
  const match = /^([a-f0-9]{64})  ([^/\n]+)\n?$/u.exec(sidecar);
  assert(match, `invalid digest sidecar ${relative(ROOT, path)}.sha256`);
  assert(
    match[2] === basename(path),
    `wrong sidecar filename for ${relative(ROOT, path)}`,
  );
  assert(
    match[1] === (await digest(path)),
    `digest mismatch for ${relative(ROOT, path)}`,
  );
  return match[1];
}

async function listJsonAuthorities(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await listJsonAuthorities(path)));
    if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
  }
  return result.sort();
}

async function absent(path, label) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must be absent`);
}

async function containsFile(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await containsFile(join(root, entry.name)))) {
      return true;
    }
  }
  return false;
}

export async function verifyProviderCustody() {
  const descriptorPath = join(RELEASE, "version.json");
  const registryPath = join(RELEASE, "registry.json");
  const deltaPath = join(RELEASE, "compatibility", "1.1.4-delta-policy.json");
  const removalPath = join(
    RELEASE,
    "compatibility",
    "service-form-removal-policy.json",
  );
  const [descriptor, registry, delta, removal, packageJson, dashboardPackage] =
    await Promise.all([
      json(descriptorPath),
      json(registryPath),
      json(deltaPath),
      json(removalPath),
      json(join(ROOT, "package.json")),
      json(join(ROOT, "dashboard", "package.json")),
    ]);

  assert(descriptor.version === "1.1.4", "custody snapshot must remain 1.1.4");
  assert(descriptor.tag === "provider/v1.1.4", "custody tag drifted");
  assert(
    descriptor.status === "discontinued",
    "provider must remain discontinued",
  );
  assert(
    descriptor.publishable === false,
    "discontinued provider cannot be publishable",
  );
  assert(
    descriptor.newVersionsAllowed === false,
    "new provider versions must be forbidden",
  );
  assert(
    descriptor.publicationPolicy?.mode === "disabled",
    "provider publication must remain disabled",
  );
  assert(
    descriptor.publicationPolicy?.status === "cancelled-discontinued",
    "provider publication status drifted",
  );
  assert(
    descriptor.replacement?.portableFormsAndResourceInterfaceDescriptors ===
      "registry.terraform.io/tako0614/takoform",
    "portable Form/Resource Interface descriptor replacement must remain Takoform",
  );

  assert(
    registry.providerAddress === descriptor.providerAddress,
    "registry address drifted",
  );
  assert(
    Array.isArray(registry.versions) && registry.versions.length === 1,
    "registry must retain only historical 1.0.0",
  );
  assert(
    registry.versions[0]?.version === "1.0.0" &&
      registry.versions[0]?.classification === "historical-quarantine",
    "1.0.0 must remain historical quarantine",
  );
  assert(
    !registry.versions.some((entry) => entry.classification === "approved"),
    "discontinued provider cannot admit mirror releases",
  );

  assert(
    delta.kind === "takosumi.provider-cancelled-delta-record@v1" &&
      delta.releaseEligibility === "cancelled-discontinued",
    "1.1.4 must remain cancelled custody evidence",
  );
  assert(
    removal.supportWindow?.minimumDays === 365,
    "legacy state support window must remain at least 365 days",
  );
  assert(
    removal.supportWindow?.startedAt === null,
    "legacy state removal window must not start implicitly",
  );

  const failures = (await readdir(join(RELEASE, "failures")))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert(
    JSON.stringify(failures) ===
      JSON.stringify(["1.1.0.json", "1.1.1.json", "1.1.2.json", "1.1.3.json"]),
    "failed candidate custody set drifted",
  );
  await absent(
    join(ROOT, ".github", "workflows", "provider-release.yml"),
    "provider publication workflow",
  );
  await absent(
    join(ROOT, "tests", "proofs", "resource-shape-opentofu-provider.ts"),
    "active Takosumi provider lifecycle proof",
  );
  await absent(
    join(ROOT, "core", "shared", "capsule_run_tokens.ts"),
    "retired Takosumi provider Capsule run-token authority",
  );
  await absent(
    join(ROOT, "tests", "core", "api", "interface_capsule_actor_test.ts"),
    "retired Capsule provider-authoring route proof",
  );
  assert(
    !(await containsFile(join(ROOT, "provider", "examples"))),
    "active Takosumi provider examples must be absent",
  );

  const forbiddenScripts = [
    "opentofu:resource-shape-provider-proof",
    "opentofu:takos-shape-provider-proof",
    "opentofu:yurucommu-shape-provider-proof",
    "provider:assets",
    "provider:compatibility:check",
    "provider:compatibility:release-check",
    "provider:compatibility:state-proof",
    "provider:release:build",
    "provider:release:verify",
    "provider:release:verify-tag",
    "provider:release:candidate",
    "provider:release:approval",
    "provider:release:prepublish",
    "provider:mirror:materialize",
    "provider:mirror:proof",
  ];
  for (const name of forbiddenScripts) {
    assert(
      !(name in packageJson.scripts),
      `active provider publication script remains: ${name}`,
    );
  }
  assert(
    packageJson.scripts["provider:custody:check"] ===
      "bun scripts/provider-custody.mjs",
    "provider custody check must remain wired",
  );
  for (const name of ["dev", "build"]) {
    const command = dashboardPackage.scripts[name];
    assert(
      !command.includes("provider-release"),
      `dashboard ${name} must not invoke provider release tooling`,
    );
    assert(
      !command.includes("materialize"),
      `dashboard ${name} must not materialize the discontinued provider mirror`,
    );
  }

  const authorities = await listJsonAuthorities(RELEASE);
  const digests = {};
  for (const path of authorities) {
    digests[relative(RELEASE, path)] = await verifySidecar(path);
  }

  return {
    kind: "takosumi.provider-custody@v1",
    status: "discontinued",
    publishable: false,
    newVersionsAllowed: false,
    retainedVersion: "1.0.0",
    cancelledSnapshot: "1.1.4",
    releaseWorkflow: "absent",
    defaultMirrorVersions: [],
    authorityDigests: digests,
  };
}

if (import.meta.main) {
  process.stdout.write(
    `${JSON.stringify(await verifyProviderCustody(), null, 2)}\n`,
  );
}
