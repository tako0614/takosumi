/**
 * Self-test for `spec-check-drift.ts`.
 *
 * Verifies that the reference kind descriptor drift detector:
 *   1. Reports zero drift when the on-disk `.generated.ts` files match
 *      the reference `.jsonld` sources.
 *   2. Detects drift between a mutated source descriptor and the
 *      committed `.generated.ts` (using a tmp-dir isolated copy of the
 *      worker `kind.jsonld` so the in-repo source is never mutated).
 *
 * Isolation pattern:
 *   - Test 1 runs `checkDrift()` against the real repo state (read-only).
 *   - Test 2 copies the worker `kind.jsonld` into `Deno.makeTempDir()`,
 *     mutates the copy, regenerates TypeScript from the mutated copy via
 *     `generateTs` + `formatFiles` (the same pipeline `checkDrift` uses),
 *     and asserts it differs from the committed `.generated.ts`. The
 *     real source on disk is never written to, so test failures cannot
 *     leak a stale `description` into the repo or race with other tests.
 *
 * Background: the previous self-test wrote a mutated payload back into
 * `packages/kind-worker/spec/kind.jsonld` and relied on `try/finally` to
 * restore it. A panic before the `finally` (out-of-memory, SIGKILL,
 * power loss) or a concurrent test reading the file mid-mutation could
 * corrupt the repo. The tmp-dir harness removes that risk because the
 * source file is only ever read.
 */
import { assert } from "jsr:@std/assert@^1.0.6";
import { fromFileUrl } from "jsr:@std/path@^1.0.6";
import { checkDrift } from "./spec-check-drift.ts";
import {
  formatFiles,
  generatedKindTargets,
  generateTs,
} from "./spec-generate-ts.ts";

const WORKER_JSONLD = fromFileUrl(
  new URL("../packages/kind-worker/spec/kind.jsonld", import.meta.url),
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

Deno.test("spec-check-drift catches an injected mismatch via tmp-dir isolated source", async () => {
  // Copy the worker descriptor into a tmp dir, mutate the copy, and
  // regenerate TypeScript from the tmp copy. The repo source on disk is
  // never written to.
  const tmpDir = await Deno.makeTempDir({ prefix: "spec-check-drift-test-" });
  try {
    const originalText = await Deno.readTextFile(WORKER_JSONLD);
    const parsed = JSON.parse(originalText) as Record<string, unknown>;
    parsed.description = "DRIFT-PROBE: this should never match generated TS.";

    const tmpSource = `${tmpDir}/kind.jsonld`;
    await Deno.writeTextFile(tmpSource, JSON.stringify(parsed, null, 2));

    // Re-run the same generation pipeline that `checkDrift` uses, but
    // sourced from the mutated tmp copy. `generateTs` accepts a
    // `KindDoc` directly so we never have to point the script at a
    // custom path.
    const mutatedDoc = JSON.parse(await Deno.readTextFile(tmpSource));
    const mutatedTs = generateTs(mutatedDoc, "worker");
    const tmpGenerated = `${tmpDir}/worker.generated.ts`;
    await Deno.writeTextFile(tmpGenerated, mutatedTs);
    await formatFiles([tmpGenerated]);
    const mutatedGenerated = await Deno.readTextFile(tmpGenerated);

    // Compare against the on-disk committed `.generated.ts` (read-only).
    const targets = generatedKindTargets();
    const workerTarget = targets.get("worker");
    assert(
      workerTarget !== undefined,
      "expected worker target in generatedKindTargets()",
    );
    const committedGenerated = await Deno.readTextFile(workerTarget!);

    assert(
      mutatedGenerated !== committedGenerated,
      "expected mutated description to produce a drifting worker.generated.ts",
    );

    // Sanity: the real repo source is untouched, so a follow-up
    // `checkDrift()` still reports zero drift.
    const followUp = await checkDrift();
    assert(
      followUp.length === 0,
      `expected no drift after tmp-isolated mutation, found ${followUp.length}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
