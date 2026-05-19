/**
 * Phase H test — the 6 consumer .takosumi.yml manifests in the ecosystem
 * tree (yurucommu, takos-docs, takos-slide, takos-excel, takos-computer,
 * road-to-me) parse through the canonical installer parser without error,
 * and each AppSpec exposes at least one component.
 *
 * This locks in the "Phase F flip" outcome: every consumer app is on the
 * namespace pub/sub AppSpec form (= no legacy `use:` / placeholder /
 * intermediate manifest fields).
 *
 * Wave K-A (2026-05-20) status: the takosumi/ parser dropped the
 * `kind: App` root field. The 6 consumer manifests still carry it and
 * are migrated under Wave K-B (= ecosystem-side wave outside the
 * takosumi/ submodule). Gating this assertion with `ignore: true` until
 * K-B re-enables it; the helper itself is still callable for manual
 * `deno run --allow-read scripts/_phase-h-consumer-parse-smoke.ts` runs.
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.6";
import {
  CONSUMER_APP_SPEC_PATHS,
  parseConsumerAppSpecs,
} from "./_phase-h-consumer-parse-smoke.ts";

Deno.test({
  name: "phase-h: all 6 consumer .takosumi.yml manifests parse",
  ignore: true, // Wave K-A: gated until K-B migrates consumer manifests.
  fn: async () => {
    const rows = await parseConsumerAppSpecs();
    assertEquals(rows.length, CONSUMER_APP_SPEC_PATHS.length);
    for (const row of rows) {
      assert(row.ok, `expected ${row.path} to parse, got: ${row.error}`);
      assert(
        row.id && row.id.length > 0,
        `expected ${row.path} to expose metadata.id`,
      );
      assert(
        row.components.length > 0,
        `expected ${row.path} (${row.id}) to declare at least one component`,
      );
    }
  },
});

Deno.test("phase-h: consumer manifest set covers expected 6 ecosystem apps", () => {
  // Sanity check: the 6 paths cover the bundled + standalone consumer apps.
  const ids = new Set(CONSUMER_APP_SPEC_PATHS.map((p) => p.split("/").at(-2)!));
  assert(ids.has("yurucommu"));
  assert(ids.has("takos-docs"));
  assert(ids.has("takos-slide"));
  assert(ids.has("takos-excel"));
  assert(ids.has("takos-computer"));
  assert(ids.has("road-to-me"));
  assertEquals(ids.size, 6);
});
