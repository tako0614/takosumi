/**
 * Detect drift between `packages/plugins/spec/kinds/v1/*.jsonld` and the
 * committed `packages/plugins/src/kinds/<basename>.generated.ts` files.
 *
 * The check works by regenerating each `.generated.ts` from its source
 * `.jsonld` into a temp directory (formatted by `deno fmt`) and
 * comparing the bytes against the on-disk file. Any difference fails
 * the check and prints a unified-style diff so CI can show the operator
 * what to fix (= re-run `deno task spec:generate-ts`).
 *
 * Exit codes:
 *   0 — no drift
 *   1 — drift detected (or generator / on-disk file failed to load)
 *   2 — internal error (missing source / write failure)
 */
import { generateAllToTemp, outputDir } from "./spec-generate-ts.ts";

interface DriftResult {
  readonly basename: string;
  readonly expectedPath: string;
  readonly expected: string;
  readonly actual: string;
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}

async function main(): Promise<number> {
  let generated: ReadonlyMap<string, string>;
  try {
    generated = await generateAllToTemp();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[spec:check-drift] generator failed: ${msg}`);
    return 2;
  }
  const drifts: DriftResult[] = [];
  for (const [basename, expected] of generated.entries()) {
    const actualPath = `${outputDir()}/${basename}.generated.ts`;
    let actual: string;
    try {
      actual = await Deno.readTextFile(actualPath);
    } catch {
      actual = "";
    }
    if (!byteEqual(expected, actual)) {
      drifts.push({ basename, expectedPath: actualPath, expected, actual });
    }
  }
  if (drifts.length > 0) {
    for (const d of drifts) {
      console.error(`[spec:check-drift] DRIFT in ${d.expectedPath}`);
      console.error(diff(d.actual, d.expected));
    }
    console.error(
      `[spec:check-drift] FAIL — ${drifts.length} file(s) out of sync. ` +
        `Run \`deno task spec:generate-ts\` and commit the result.`,
    );
    return 1;
  }

  console.log(
    `[spec:check-drift] OK — ${generated.size} file(s) match .jsonld sources (no drift)`,
  );
  return 0;
}

/**
 * Byte-exact equality after normalizing trailing newline. Both inputs
 * are already formatted by `deno fmt`, so this is sufficient.
 */
function byteEqual(a: string, b: string): boolean {
  return a === b;
}

/**
 * Minimal unified-style diff. Lines that match are skipped; differing
 * lines are shown with `-` (current on-disk) and `+` (regenerated).
 */
function diff(actual: string, expected: string): string {
  const aLines = actual.split("\n");
  const eLines = expected.split("\n");
  const out: string[] = [];
  const max = Math.max(aLines.length, eLines.length);
  for (let i = 0; i < max; i++) {
    const av = aLines[i];
    const ev = eLines[i];
    if (av === ev) continue;
    if (av !== undefined) out.push(`-${av}`);
    if (ev !== undefined) out.push(`+${ev}`);
  }
  return out.join("\n");
}

// Used only when run as a sanity check from another script.
export async function checkDrift(): Promise<readonly DriftResult[]> {
  const generated = await generateAllToTemp();
  const drifts: DriftResult[] = [];
  for (const [basename, expected] of generated.entries()) {
    const actualPath = `${outputDir()}/${basename}.generated.ts`;
    let actual: string;
    try {
      actual = await Deno.readTextFile(actualPath);
    } catch {
      actual = "";
    }
    if (!byteEqual(expected, actual)) {
      drifts.push({ basename, expectedPath: actualPath, expected, actual });
    }
  }
  return drifts;
}

export { outputDir as kindsOutputDir };
