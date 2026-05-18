/**
 * Phase H consumer .takosumi.yml parse smoke — verify that the 6 bundled +
 * standalone consumer app manifests (yurucommu, takos-docs, takos-slide,
 * takos-excel, takos-computer, road-to-me) all parse successfully through
 * the canonical installer parser.
 *
 * Run from `takosumi/`:
 *
 *   deno run --allow-read scripts/_phase-h-consumer-parse-smoke.ts
 *
 * Also executed as a deno test under
 * `scripts/_phase-h-consumer-parse-smoke_test.ts` so the assertion enters the
 * standard `deno test` count.
 */

import { parseAppSpec } from "../packages/installer/src/yaml-parser.ts";

export const CONSUMER_APP_SPEC_PATHS: readonly string[] = [
  "/home/tako/Desktop/takos/yurucommu/.takosumi.yml",
  "/home/tako/Desktop/takos/takos-apps/takos-docs/.takosumi.yml",
  "/home/tako/Desktop/takos/takos-apps/takos-slide/.takosumi.yml",
  "/home/tako/Desktop/takos/takos-apps/takos-excel/.takosumi.yml",
  "/home/tako/Desktop/takos/takos-apps/takos-computer/.takosumi.yml",
  "/home/tako/Desktop/takos/road-to-me/.takosumi.yml",
] as const;

export interface ConsumerParseRow {
  readonly path: string;
  readonly ok: boolean;
  readonly id?: string;
  readonly components: readonly string[];
  readonly error?: string;
}

export async function parseConsumerAppSpecs(): Promise<ConsumerParseRow[]> {
  const rows: ConsumerParseRow[] = [];
  for (const path of CONSUMER_APP_SPEC_PATHS) {
    try {
      const bytes = await Deno.readTextFile(path);
      const spec = parseAppSpec(bytes);
      const components = spec.components ? Object.keys(spec.components) : [];
      rows.push({ path, ok: true, id: spec.metadata.id, components });
    } catch (err) {
      rows.push({
        path,
        ok: false,
        components: [],
        error: (err as Error).message,
      });
    }
  }
  return rows;
}

if (import.meta.main) {
  const rows = await parseConsumerAppSpecs();
  let bad = 0;
  for (const row of rows) {
    if (row.ok) {
      console.log(
        `OK  ${row.path} — ${row.id} (${row.components.length} component(s): ${
          row.components.join(", ")
        })`,
      );
    } else {
      bad += 1;
      console.log(`FAIL ${row.path} — ${row.error}`);
    }
  }
  console.log(`\nResult: ${rows.length - bad} ok, ${bad} failed`);
  if (bad > 0) Deno.exit(1);
}
