/**
 * Operator first-run aid: list the durable resources the platform worker needs.
 *
 * `wrangler deploy` succeeds even when a binding's underlying resource is
 * missing, so this script prints the required resource set (D1 / R2 / Durable
 * Objects / queue / ASSETS) as a checklist. It is a DRY-RUN reference — it does
 * not create anything (resource creation requires operator credentials and the
 * realized config in the operator-private repo). Pair it with the worker's
 * `/readyz` self-check, which fails loudly at runtime when a binding is absent.
 *
 * Run: `bun scripts/check-platform-bindings.ts`
 */
import { REQUIRED_PLATFORM_BINDINGS } from "../deploy/accounts-cloudflare/src/bindings-check.ts";

const SECTIONS: ReadonlyArray<{ readonly label: string; readonly names: readonly string[] }> = [
  { label: "D1 databases", names: REQUIRED_PLATFORM_BINDINGS.d1 },
  { label: "R2 buckets", names: REQUIRED_PLATFORM_BINDINGS.r2 },
  { label: "Durable Objects", names: REQUIRED_PLATFORM_BINDINGS.durableObjects },
  { label: "Queues", names: REQUIRED_PLATFORM_BINDINGS.queues },
  { label: "Static assets", names: REQUIRED_PLATFORM_BINDINGS.assets },
];

function main(): void {
  console.log("Platform worker required bindings (deploy/platform/wrangler.toml):\n");
  for (const section of SECTIONS) {
    console.log(`  ${section.label}:`);
    for (const name of section.names) {
      console.log(`    - ${name}`);
    }
  }
  console.log(
    "\nThis is a checklist only. Provision the underlying resources with your\n" +
      "operator wrangler/Cloudflare credentials and wire the realized ids in the\n" +
      "operator-private config. After deploy, GET /readyz on the worker fails\n" +
      "with the named missing required bindings until every one is present.\n" +
      "Cloud extension service bindings are NOT part of OSS/operator readiness;\n" +
      "the closed Takosumi Cloud delta declares them via TAKOSUMI_CLOUD_EXTENSIONS\n" +
      "plus the named service bindings in its realized operator-private config.",
  );
}

main();
