/**
 * Phase H test — the 6 consumer .takosumi.yml manifests in the ecosystem
 * tree (yurucommu, takos-docs, takos-slide, takos-excel, takos-computer,
 * road-to-me) parse through the canonical installer parser without error,
 * and each AppSpec exposes at least one component.
 *
 * This locks in the "Phase F flip" outcome: every consumer app is on the
 * connect/listen AppSpec form (= no legacy `use:` / placeholder /
 * intermediate manifest fields).
 */

import { assert, assertEquals } from "jsr:@std/assert@^1.0.6";
import {
  CONSUMER_APP_SPEC_PATHS,
  parseConsumerAppSpecs,
} from "./_phase-h-consumer-parse-smoke.ts";

Deno.test({
  name: "phase-h: all 6 consumer .takosumi.yml manifests parse",
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
