/**
 * Self-test for `spec-check-drift.ts`.
 *
 * Verifies that the reference kind descriptor drift detector:
 *   1. Reports zero drift when the on-disk `.generated.ts` files match
 *      the reference `.jsonld` sources.
 *   2. Reports drift when one `.jsonld` is mutated relative to its
 *      generated TS (we mutate the description field to a different
 *      string).
 *   3. Returns to zero drift after the mutation is reverted.
 *
 * Strategy:
 *   - Read the worker `.jsonld` and `.generated.ts` files up-front.
 *   - Run drift check (= must be empty).
 *   - Write a mutated `.jsonld` (different `description`), run drift
 *     check (= must contain `worker`).
 *   - Restore the original `.jsonld`, run drift check (= must be empty).
 *
 * The test isolates side-effects by restoring file contents in a
 * `finally` block, so it is safe even if the assertions fail.
 */
import { assert } from "jsr:@std/assert@^1.0.6";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";
import { checkDrift } from "./spec-check-drift.ts";

const WORKER_JSONLD = fromFileUrl(
  new URL("../packages/plugins/spec/kinds/v1/worker.jsonld", import.meta.url),
);

Deno.test("spec-check-drift reports no drift on the committed source", async () => {
  const drifts = await checkDrift();
  assert(
    drifts.length === 0,
    `expected no drift, found ${drifts.length}: ${
      drifts.map((d) => d.basename).join(", ")
    }`,
  );
});

Deno.test("spec-check-drift catches an injected mismatch", async () => {
  const original = await Deno.readTextFile(WORKER_JSONLD);
  try {
    const parsed = JSON.parse(original) as Record<string, unknown>;
    parsed.description = "DRIFT-PROBE: this should never match generated TS.";
    await Deno.writeTextFile(WORKER_JSONLD, JSON.stringify(parsed, null, 2));
    const drifts = await checkDrift();
    assert(
      drifts.some((d) => d.basename === "worker"),
      `expected worker drift to be flagged, got: ${
        drifts.map((d) => d.basename).join(", ")
      }`,
    );
  } finally {
    await Deno.writeTextFile(WORKER_JSONLD, original);
  }
  // After restore, drift should be gone.
  const finalDrifts = await checkDrift();
  assert(
    finalDrifts.length === 0,
    `expected no drift after restoring source, found ${finalDrifts.length}`,
  );
});
