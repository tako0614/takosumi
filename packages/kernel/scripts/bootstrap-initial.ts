/**
 * Initial admin / tenant bootstrap script (Phase 11C).
 *
 * Creates the first admin account, the initial tenant Space + Group, seeds the
 * default app distribution descriptors, and registers the operator-controlled
 * registry trust roots. Designed to be **idempotent**: re-running against a
 * machine that already has an admin / tenant skips creation and re-prints the
 * existing PAT (when it can be located in the secret store).
 *
 * Usage:
 *   cd takos/paas && deno task bootstrap:initial \
 *     --admin-email=admin@example.com \
 *     [--tenant-name="Takos"] \
 *     [--env=staging|production|local] \
 *     [--dry-run]
 *
 * Inputs (env):
 *   TAKOS_DEFAULT_APP_DISTRIBUTION_JSON  JSON array of default app descriptors
 *                                        seeded into the registry. Each entry:
 *                                        { ref, version, digest, publisher? }
 *   TAKOS_REGISTRY_TRUST_ROOTS_JSON      JSON array of registry trust roots:
 *                                        { id, packageRef, packageDigest,
 *                                          packageKind?, trustLevel?,
 *                                          conformanceTier?, verifiedBy? }
 *
 * Outputs (stdout): admin email + initial PAT (operator login secret).
 */

import type { TakosActorContext } from "takosumi-contract";
import {
  createCoreDomainServices,
  createInMemoryCoreDomainDependencies,
} from "../src/domains/core/mod.ts";
import {
  type ConformanceTier,
  InMemoryPackageDescriptorStore,
  InMemoryPackageResolutionStore,
  InMemoryTrustRecordStore,
  type PackageDescriptor,
  type PackageKind,
  type TrustLevel,
  type TrustRecord,
} from "../src/domains/registry/mod.ts";
import { MemoryEncryptedSecretStore } from "../src/adapters/secret-store/memory.ts";

interface CliArgs {
  readonly adminEmail: string;
  readonly tenantName: string;
  readonly environment: string;
  readonly dryRun: boolean;
}

interface DefaultAppEntry {
  readonly ref: string;
  readonly version?: string;
  readonly digest: string;
  readonly publisher?: string;
  readonly kind?: PackageKind;
}

interface TrustRootEntry {
  readonly id: string;
  readonly packageRef: string;
  readonly packageDigest: string;
  readonly packageKind?: PackageKind;
  readonly trustLevel?: TrustLevel;
  readonly conformanceTier?: ConformanceTier;
  readonly verifiedBy?: string;
}

interface BootstrapPlan {
  readonly args: CliArgs;
  readonly accountId: string;
  readonly spaceId: string;
  readonly groupSlug: string;
  readonly defaultApps: readonly DefaultAppEntry[];
  readonly trustRoots: readonly TrustRootEntry[];
}

interface BootstrapOutcome {
  readonly skipped: boolean;
  readonly adminEmail: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly pat: string;
  readonly patReused: boolean;
  readonly defaultAppCount: number;
  readonly trustRootCount: number;
}

const ADMIN_PAT_SECRET_PREFIX = "pat:admin:";

function parseArgs(argv: readonly string[]): CliArgs {
  const map = new Map<string, string>();
  let dryRun = false;
  for (const raw of argv) {
    if (raw === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const key = raw.slice(2, eq);
    const value = raw.slice(eq + 1);
    map.set(key, value);
  }
  const adminEmail = map.get("admin-email")?.trim();
  if (!adminEmail) {
    throw new Error(
      "missing required flag: --admin-email=<email>",
    );
  }
  if (!isLikelyEmail(adminEmail)) {
    throw new Error(`--admin-email is not a valid email: ${adminEmail}`);
  }
  return {
    adminEmail,
    tenantName: (map.get("tenant-name") ?? "Takos").trim() || "Takos",
    environment: (map.get("env") ?? "local").trim() || "local",
    dryRun,
  };
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function accountIdFromEmail(email: string): string {
  const sanitized = email.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(
    /^_+|_+$/g,
    "",
  );
  return `acct_admin_${sanitized}`;
}

function spaceIdFromTenantName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return `space_${sanitized || "tenant"}`;
}

function groupSlugFromTenantName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return sanitized || "default";
}

function loadDefaultApps(env: Record<string, string | undefined>): {
  readonly entries: readonly DefaultAppEntry[];
  readonly diagnostic?: string;
} {
  const raw = env.TAKOS_DEFAULT_APP_DISTRIBUTION_JSON;
  if (!raw || !raw.trim()) return { entries: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        entries: [],
        diagnostic:
          "TAKOS_DEFAULT_APP_DISTRIBUTION_JSON must be a JSON array; ignored",
      };
    }
    const entries: DefaultAppEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const ref = typeof record.ref === "string" ? record.ref : undefined;
      const digest = typeof record.digest === "string"
        ? record.digest
        : undefined;
      if (!ref || !digest) continue;
      entries.push({
        ref,
        digest,
        version: typeof record.version === "string"
          ? record.version
          : undefined,
        publisher: typeof record.publisher === "string"
          ? record.publisher
          : undefined,
        kind: isPackageKind(record.kind) ? record.kind : undefined,
      });
    }
    return { entries };
  } catch (err) {
    return {
      entries: [],
      diagnostic: `TAKOS_DEFAULT_APP_DISTRIBUTION_JSON is not valid JSON (${
        (err as Error).message
      }); ignored`,
    };
  }
}

function loadTrustRoots(env: Record<string, string | undefined>): {
  readonly entries: readonly TrustRootEntry[];
  readonly diagnostic?: string;
} {
  const raw = env.TAKOS_REGISTRY_TRUST_ROOTS_JSON;
  if (!raw || !raw.trim()) return { entries: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        entries: [],
        diagnostic:
          "TAKOS_REGISTRY_TRUST_ROOTS_JSON must be a JSON array; ignored",
      };
    }
    const entries: TrustRootEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : undefined;
      const packageRef = typeof record.packageRef === "string"
        ? record.packageRef
        : undefined;
      const packageDigest = typeof record.packageDigest === "string"
        ? record.packageDigest
        : undefined;
      if (!id || !packageRef || !packageDigest) continue;
      entries.push({
        id,
        packageRef,
        packageDigest,
        packageKind: isPackageKind(record.packageKind)
          ? record.packageKind
          : undefined,
        trustLevel: isTrustLevel(record.trustLevel)
          ? record.trustLevel
          : undefined,
        conformanceTier: isConformanceTier(record.conformanceTier)
          ? record.conformanceTier
          : undefined,
        verifiedBy: typeof record.verifiedBy === "string"
          ? record.verifiedBy
          : undefined,
      });
    }
    return { entries };
  } catch (err) {
    return {
      entries: [],
      diagnostic: `TAKOS_REGISTRY_TRUST_ROOTS_JSON is not valid JSON (${
        (err as Error).message
      }); ignored`,
    };
  }
}

function isPackageKind(value: unknown): value is PackageKind {
  return value === "provider-package" ||
    value === "resource-contract-package" ||
    value === "data-contract-package" ||
    value === "output-contract-package" ||
    value === "native-schema" ||
    value === "capability-profile";
}

function isTrustLevel(value: unknown): value is TrustLevel {
  return value === "official" || value === "verified" || value === "local" ||
    value === "untrusted";
}

function isConformanceTier(value: unknown): value is ConformanceTier {
  return value === "unknown" || value === "declared" || value === "tested" ||
    value === "certified";
}

function generatePat(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `tk_pat_${hex}`;
}

function buildPlan(args: CliArgs): BootstrapPlan {
  const env = Deno.env.toObject();
  const defaultApps = loadDefaultApps(env);
  const trustRoots = loadTrustRoots(env);
  if (defaultApps.diagnostic) {
    console.warn(`warning: ${defaultApps.diagnostic}`);
  }
  if (trustRoots.diagnostic) {
    console.warn(`warning: ${trustRoots.diagnostic}`);
  }
  return {
    args,
    accountId: accountIdFromEmail(args.adminEmail),
    spaceId: spaceIdFromTenantName(args.tenantName),
    groupSlug: groupSlugFromTenantName(args.tenantName),
    defaultApps: defaultApps.entries,
    trustRoots: trustRoots.entries,
  };
}

async function executePlan(plan: BootstrapPlan): Promise<BootstrapOutcome> {
  const coreDeps = createInMemoryCoreDomainDependencies();
  const coreServices = createCoreDomainServices(coreDeps);
  const descriptors = new InMemoryPackageDescriptorStore();
  const resolutions = new InMemoryPackageResolutionStore();
  const trustRecords = new InMemoryTrustRecordStore();
  const secrets = new MemoryEncryptedSecretStore({});

  const existingSpace = await coreDeps.spaces.get(plan.spaceId);
  const patSecretName =
    `${ADMIN_PAT_SECRET_PREFIX}${plan.args.adminEmail.toLowerCase()}`;
  const existingPat = await secrets.latestSecret(patSecretName);

  if (existingSpace && existingPat) {
    const patValue = await secrets.getSecret({
      name: existingPat.name,
      version: existingPat.version,
    });
    const memberships = await coreDeps.memberships.listBySpace(
      existingSpace.id,
    );
    const groups = await coreDeps.groups.listBySpace(existingSpace.id);
    return {
      skipped: true,
      adminEmail: plan.args.adminEmail,
      accountId: memberships[0]?.accountId ?? plan.accountId,
      spaceId: existingSpace.id,
      groupId: groups[0]?.id ?? "",
      pat: patValue ?? "",
      patReused: true,
      defaultAppCount: plan.defaultApps.length,
      trustRootCount: plan.trustRoots.length,
    };
  }

  const actor: TakosActorContext = {
    actorAccountId: plan.accountId,
    roles: ["owner"],
    requestId: `bootstrap-initial-${crypto.randomUUID()}`,
    principalKind: "account",
  };

  const space = await coreServices.spaces.createSpace({
    actor,
    spaceId: plan.spaceId,
    name: plan.args.tenantName,
    metadata: {
      bootstrap: true,
      environment: plan.args.environment,
      adminEmail: plan.args.adminEmail,
    },
  });
  if (!space.ok) {
    throw new Error(
      `failed to create initial space: ${space.error.code} ${space.error.message}`,
    );
  }

  const group = await coreServices.groups.createGroup({
    actor,
    spaceId: space.value.id,
    slug: plan.groupSlug,
    displayName: plan.args.tenantName,
    metadata: { bootstrap: true },
  });
  if (!group.ok) {
    throw new Error(
      `failed to create initial group: ${group.error.code} ${group.error.message}`,
    );
  }

  const pat = generatePat();
  await secrets.putSecret({
    name: patSecretName,
    value: pat,
    metadata: {
      adminEmail: plan.args.adminEmail,
      accountId: plan.accountId,
      spaceId: space.value.id,
      bootstrap: true,
      environment: plan.args.environment,
    },
  });

  const verifiedAt = new Date().toISOString();
  for (const entry of plan.defaultApps) {
    const descriptor: PackageDescriptor = {
      ref: entry.ref,
      kind: entry.kind ?? "native-schema",
      digest: entry.digest,
      publisher: entry.publisher ?? "takos",
      version: entry.version,
      body: {
        ref: entry.ref,
        digest: entry.digest,
        seededByBootstrap: true,
        environment: plan.args.environment,
      },
      publishedAt: verifiedAt,
    };
    await descriptors.put(descriptor);
    await resolutions.record({
      ref: descriptor.ref,
      kind: descriptor.kind,
      digest: descriptor.digest,
      registry: "bundled",
      resolvedAt: verifiedAt,
    });
  }

  for (const root of plan.trustRoots) {
    const record: TrustRecord = {
      id: root.id,
      packageRef: root.packageRef,
      packageDigest: root.packageDigest,
      packageKind: root.packageKind ?? "provider-package",
      trustLevel: root.trustLevel ?? "official",
      status: "active",
      conformanceTier: root.conformanceTier ?? "declared",
      verifiedBy: root.verifiedBy ?? "takos",
      verifiedAt,
    };
    await trustRecords.put(record);
  }

  return {
    skipped: false,
    adminEmail: plan.args.adminEmail,
    accountId: plan.accountId,
    spaceId: space.value.id,
    groupId: group.value.id,
    pat,
    patReused: false,
    defaultAppCount: plan.defaultApps.length,
    trustRootCount: plan.trustRoots.length,
  };
}

function previewPlan(plan: BootstrapPlan): void {
  console.log("--- bootstrap-initial preview (--dry-run) ---");
  console.log(`environment       : ${plan.args.environment}`);
  console.log(`admin email       : ${plan.args.adminEmail}`);
  console.log(`admin account id  : ${plan.accountId}`);
  console.log(`tenant name       : ${plan.args.tenantName}`);
  console.log(`tenant space id   : ${plan.spaceId}`);
  console.log(`tenant group slug : ${plan.groupSlug}`);
  console.log(
    `default apps to seed: ${plan.defaultApps.length}${
      plan.defaultApps.length
        ? ` (${plan.defaultApps.map((entry) => entry.ref).join(", ")})`
        : ""
    }`,
  );
  console.log(
    `registry trust roots: ${plan.trustRoots.length}${
      plan.trustRoots.length
        ? ` (${plan.trustRoots.map((entry) => entry.id).join(", ")})`
        : ""
    }`,
  );
  console.log(
    "PAT will be generated (32 random bytes, prefix tk_pat_) and stored as " +
      `secret '${ADMIN_PAT_SECRET_PREFIX}${plan.args.adminEmail.toLowerCase()}'.`,
  );
  console.log("no DB writes performed (dry-run).");
}

function reportOutcome(outcome: BootstrapOutcome): void {
  console.log("");
  console.log("--- bootstrap-initial result ---");
  if (outcome.skipped) {
    console.log("status            : skipped (existing admin / tenant found)");
  } else {
    console.log("status            : created");
  }
  console.log(`admin email       : ${outcome.adminEmail}`);
  console.log(`admin account id  : ${outcome.accountId}`);
  console.log(`tenant space id   : ${outcome.spaceId}`);
  if (outcome.groupId) console.log(`tenant group id   : ${outcome.groupId}`);
  console.log(`default apps seeded : ${outcome.defaultAppCount}`);
  console.log(`registry trust roots: ${outcome.trustRootCount}`);
  console.log("");
  console.log(
    `Initial PAT (operator login)${outcome.patReused ? " [reused]" : ""}:`,
  );
  console.log(`  email : ${outcome.adminEmail}`);
  console.log(`  pat   : ${outcome.pat || "<unavailable>"}`);
  console.log("");
  console.log(
    "Store this PAT securely; it grants admin access on first login.",
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    console.error("");
    console.error(
      "usage: bootstrap-initial.ts --admin-email=<email> [--tenant-name=<name>] " +
        "[--env=staging|production|local] [--dry-run]",
    );
    return 2;
  }
  const plan = buildPlan(args);
  if (args.dryRun) {
    previewPlan(plan);
    return 0;
  }
  try {
    const outcome = await executePlan(plan);
    reportOutcome(outcome);
    return 0;
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
