/**
 * Project the one platform-binding declaration onto every artifact that carries
 * a copy of it.
 *
 * WHY. `deploy/accounts-cloudflare/src/bindings-check.ts` was the authority in
 * name only. Four artifacts each held their own list and no two agreed: the
 * release gate named six bindings and neither R2 nor the Durable Objects; the
 * shipped OSS template omitted `HOSTED`, so the template this repository ships
 * could not satisfy its own release gate; the local-substrate runner
 * enumerated a third set. This script existed, imported the authority, printed
 * a checklist — and was in no package script, so nothing ever compared them.
 *
 * `--check` compares. It reads the committed artifacts and diffs them against
 * the table in both directions: a declared binding missing from an artifact it
 * is declared for, and a binding an artifact carries that nothing declares.
 * The release list is no longer compared at all, because it is now derived
 * from the same table rather than restated.
 *
 * Run: `bun scripts/check-platform-bindings.ts` (checklist)
 *      `bun scripts/check-platform-bindings.ts --check` (gate)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PLATFORM_BINDINGS,
  platformBindingNames,
  type PlatformBindingList,
} from "../deploy/accounts-cloudflare/src/bindings-check.ts";

const ROOT = resolve(import.meta.dir, "..");
const OSS_TEMPLATE = resolve(ROOT, "deploy/platform/wrangler.toml");
const LOCAL_SUBSTRATE = resolve(
  ROOT,
  "deploy/local-substrate/wrappers/takosumi-platform-worker-runner.mjs",
);

const SECTIONS: ReadonlyArray<{
  readonly label: string;
  readonly names: readonly string[];
}> = [
  { label: "D1 databases", names: platformBindingNames("readiness", "d1") },
  { label: "R2 buckets", names: platformBindingNames("readiness", "r2") },
  {
    label: "Durable Objects",
    names: platformBindingNames("readiness", "durableObject"),
  },
  { label: "Static assets", names: platformBindingNames("readiness", "assets") },
];

export function renderPlatformBindingsChecklist(): string {
  const lines = [
    "Platform worker required bindings (deploy/platform/wrangler.toml):",
    "",
  ];
  for (const section of SECTIONS) {
    lines.push(`  ${section.label}:`);
    for (const name of section.names) {
      lines.push(`    - ${name}`);
    }
  }
  lines.push(
    "",
    "This is a checklist only. Provision the underlying resources with your",
    "operator wrangler/Cloudflare credentials and wire the realized ids in the",
    "operator-private config. After deploy, GET /readyz on the worker fails",
    "with the named missing required bindings until every one is present.",
    "Optional extension handlers are NOT part of OSS/operator readiness.",
    "TAKOSUMI_PLATFORM_EXTENSIONS names logical handler keys that an operator",
    "composition resolves in-process; do not add separate [[services]]",
    "bindings unless the operator deliberately uses a remote service.",
  );
  return `${lines.join("\n")}\n`;
}

/** Binding names the shipped OSS wrangler template actually declares. */
export function ossTemplateBindings(source: string): readonly string[] {
  const parsed = Bun.TOML.parse(source) as Record<string, unknown>;
  const names: string[] = [];
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  for (const entry of (parsed.d1_databases as unknown[]) ?? []) {
    if (record(entry) && typeof entry.binding === "string") {
      names.push(entry.binding);
    }
  }
  for (const entry of (parsed.r2_buckets as unknown[]) ?? []) {
    if (record(entry) && typeof entry.binding === "string") {
      names.push(entry.binding);
    }
  }
  const durableObjects = parsed.durable_objects;
  if (record(durableObjects)) {
    for (const entry of (durableObjects.bindings as unknown[]) ?? []) {
      if (record(entry) && typeof entry.name === "string") {
        names.push(entry.name);
      }
    }
  }
  if (record(parsed.assets) && typeof parsed.assets.binding === "string") {
    names.push(parsed.assets.binding);
  }
  if (
    record(parsed.version_metadata) &&
    typeof parsed.version_metadata.binding === "string"
  ) {
    names.push(parsed.version_metadata.binding);
  }
  for (const entry of (parsed.services as unknown[]) ?? []) {
    if (record(entry) && typeof entry.binding === "string") {
      names.push(entry.binding);
    }
  }
  return names;
}

/**
 * Binding names the local-substrate Miniflare runner configures.
 *
 * The runner is JavaScript, not data, so this reads the three literal
 * configuration blocks rather than pretending to evaluate it. A binding moved
 * out of a literal shows up as an absence, which is the failure this catches.
 */
export function localSubstrateBindings(source: string): readonly string[] {
  const names: string[] = [];
  const d1 = /d1Databases:\s*\{([\s\S]*?)\}/u.exec(source)?.[1] ?? "";
  for (const match of d1.matchAll(/^\s*([A-Z0-9_]+)\s*:/gmu)) {
    names.push(match[1]!);
  }
  const r2 = /r2Buckets:\s*\[([\s\S]*?)\]/u.exec(source)?.[1] ?? "";
  for (const match of r2.matchAll(/"([A-Z0-9_]+)"/gu)) names.push(match[1]!);
  const durable =
    /durableObjects:\s*\{([\s\S]*?)\n\s*\},\n\s*durableObjectsPersist/u.exec(
      source,
    )?.[1] ?? "";
  for (const match of durable.matchAll(/^\s*([A-Z0-9_]+)\s*:\s*\{/gmu)) {
    names.push(match[1]!);
  }
  return names;
}

function diff(
  label: string,
  list: PlatformBindingList,
  found: readonly string[],
): readonly string[] {
  const declared = new Set(platformBindingNames(list));
  const present = new Set(found);
  const failures: string[] = [];
  for (const name of declared) {
    if (!present.has(name)) {
      failures.push(
        `${label} is missing ${name} (${PLATFORM_BINDINGS[name]?.why ?? "declared for this artifact"})`,
      );
    }
  }
  for (const name of present) {
    if (declared.has(name)) continue;
    const declaration = PLATFORM_BINDINGS[name];
    failures.push(
      declaration
        ? `${label} declares ${name}, which is declared for ${
            declaration.lists.length === 0
              ? "no artifact"
              : declaration.lists.join(", ")
          }`
        : `${label} declares ${name}, which the binding table does not declare at all`,
    );
  }
  return failures;
}

export function checkPlatformBindingProjection(input: {
  readonly ossTemplate: string;
  readonly localSubstrate: string;
}): readonly string[] {
  return [
    ...diff(
      "deploy/platform/wrangler.toml",
      "ossTemplate",
      ossTemplateBindings(input.ossTemplate),
    ),
    ...diff(
      "the local-substrate runner",
      "localSubstrate",
      localSubstrateBindings(input.localSubstrate),
    ),
  ];
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const failures = checkPlatformBindingProjection({
      ossTemplate: readFileSync(OSS_TEMPLATE, "utf8"),
      localSubstrate: readFileSync(LOCAL_SUBSTRATE, "utf8"),
    });
    if (failures.length > 0) {
      process.stderr.write("platform binding projection failed:\n");
      for (const failure of failures) process.stderr.write(`- ${failure}\n`);
      process.stderr.write(
        "\nThe declaration is deploy/accounts-cloudflare/src/bindings-check.ts.\n" +
          "Add or remove the binding there and in every artifact its `lists` name.\n",
      );
      process.exit(1);
    }
    process.stdout.write(
      `platform bindings ok: ${Object.keys(PLATFORM_BINDINGS).length} declared, ` +
        "projected into the OSS template and the local-substrate runner " +
        "(the release list is derived from the same table)\n",
    );
  } else {
    process.stdout.write(renderPlatformBindingsChecklist());
  }
}
