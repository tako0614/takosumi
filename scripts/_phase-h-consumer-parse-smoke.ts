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

import { fromFileUrl, join } from "jsr:@std/path@^1.0.6";
import { parseAppSpec } from "../src/installer/yaml-parser.ts";

// Ecosystem root は本 file (= takosumi/scripts/_phase-h-consumer-parse-smoke.ts)
// から 2 階層上。 import.meta.url 起点なので developer 個人 path や clone 先
// (= ~/Desktop/takos / /root/dev/takos / /home/<user>/<workdir>/takos 等) に
// 依存しない portable な解決。
const ECOSYSTEM_ROOT = fromFileUrl(new URL("../../", import.meta.url));

export const CONSUMER_APP_SPEC_PATHS: readonly string[] = [
  join(ECOSYSTEM_ROOT, "yurucommu", ".takosumi.yml"),
  join(ECOSYSTEM_ROOT, "takos-apps", "takos-docs", ".takosumi.yml"),
  join(ECOSYSTEM_ROOT, "takos-apps", "takos-slide", ".takosumi.yml"),
  join(ECOSYSTEM_ROOT, "takos-apps", "takos-excel", ".takosumi.yml"),
  join(ECOSYSTEM_ROOT, "takos-apps", "takos-computer", ".takosumi.yml"),
  join(ECOSYSTEM_ROOT, "road-to-me", ".takosumi.yml"),
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
