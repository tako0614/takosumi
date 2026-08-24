/**
 * Operator first-run aid: list the durable resources the platform worker needs.
 *
 * A provider deployment can succeed even when a binding's underlying resource
 * is missing, so this script prints the required resource set (D1 / R2 /
 * Durable Objects / ASSETS) as a checklist. It is a DRY-RUN reference
 * — it does not create anything (resource creation requires operator
 * credentials and the realized config in the operator-private repo). Pair it
 * with the worker's `/readyz` self-check, which fails loudly at runtime when a
 * binding is absent.
 *
 * Run: `bun scripts/check-platform-bindings.ts`
 */
import { REQUIRED_PLATFORM_BINDINGS } from "../deploy/accounts-cloudflare/src/bindings-check.ts";

const SECTIONS: ReadonlyArray<{
  readonly label: string;
  readonly names: readonly string[];
}> = [
  { label: "D1 databases", names: REQUIRED_PLATFORM_BINDINGS.d1 },
  { label: "R2 buckets", names: REQUIRED_PLATFORM_BINDINGS.r2 },
  {
    label: "Durable Objects",
    names: REQUIRED_PLATFORM_BINDINGS.durableObjects,
  },
  { label: "Static assets", names: REQUIRED_PLATFORM_BINDINGS.assets },
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

if (import.meta.main) process.stdout.write(renderPlatformBindingsChecklist());
