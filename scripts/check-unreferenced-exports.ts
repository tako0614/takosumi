/**
 * Ratchet gate: code that exists but runs nowhere.
 *
 * The install flow accumulated a complete, localized error/display layer that
 * was written, unit-tested, and then never wired into the view that shipped.
 * It looked finished in review and in the test report, so users kept seeing
 * raw English server prose while the correct Japanese copy sat one import
 * away. Superfluous code is not free: it makes the real behavior harder to
 * find, and it makes "there is already a helper for that" wrong.
 *
 * This check counts exported symbols with NO caller anywhere — not in another
 * module, not even inside their own file (a test that imports a symbol is not
 * a caller: it proves the function computes, never that anything runs it).
 * The current counts are recorded as budgets. The gate fails when a budget is
 * exceeded, so new dead code cannot land; lowering a budget after a cleanup is
 * the intended direction and the only edit this file should need.
 */

const BUDGETS: readonly { readonly file: string; readonly maximum: number }[] = [
  // Install flow helpers. Down from 28: the user-facing behavior that was
  // written but never wired is now connected (compatibility copy, classified
  // failure copy, duplicate-name suggestion, transient-failure retry), and the
  // leftovers of a replaced layout are deleted. What remains is internal
  // formatting exported for unit tests.
  { file: "dashboard/src/views/new/install-helpers.ts", maximum: 19 },
];

/** Files whose imports never count as "used": they observe, they do not run. */
const NON_CALLER_PREFIXES = ["tests/"] as const;

interface DeadExportReport {
  readonly file: string;
  readonly dead: readonly string[];
}

async function searchRoots(): Promise<readonly string[]> {
  return ["dashboard", "core", "worker", "accounts", "deploy", "cli", "lib"];
}

function exportedNames(source: string): readonly string[] {
  const names = new Set<string>();
  // Trailing `export { ... }` barrel — the shape this repo uses for helper
  // modules that keep their declarations private.
  for (const block of source.matchAll(/export\s*\{([^}]*)\}\s*;/g)) {
    for (const raw of (block[1] ?? "").split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // Inline `export function foo` / `export const foo`.
  for (const inline of source.matchAll(
    /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    if (inline[1]) names.add(inline[1]);
  }
  return [...names];
}

function declarationCount(source: string, name: string): number {
  const pattern = new RegExp(
    String.raw`(?:function|const|class|interface|type)\s+${name}\b`,
    "g",
  );
  return [...source.matchAll(pattern)].length;
}

function referenceCount(source: string, name: string): number {
  return [...source.matchAll(new RegExp(String.raw`\b${name}\b`, "g"))].length;
}

async function callersOutside(
  name: string,
  ownFile: string,
  roots: readonly string[],
): Promise<boolean> {
  const grep = Bun.spawn(
    ["grep", "-rl", "--include=*.ts", "--include=*.tsx", `\\b${name}\\b`, ...roots],
    { stdout: "pipe", stderr: "ignore" },
  );
  const output = await new Response(grep.stdout).text();
  await grep.exited;
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some(
      (file) =>
        file !== ownFile &&
        !NON_CALLER_PREFIXES.some((prefix) => file.startsWith(prefix)),
    );
}

async function deadExports(file: string): Promise<DeadExportReport> {
  const source = await Bun.file(file).text();
  const roots = await searchRoots();
  // The barrel itself re-states every name; exclude it when counting
  // in-file usage so a re-export never looks like a call.
  const withoutBarrel = source.replace(/export\s*\{[^}]*\}\s*;/g, "");
  const dead: string[] = [];
  for (const name of exportedNames(source)) {
    if (await callersOutside(name, file, roots)) continue;
    const used =
      referenceCount(withoutBarrel, name) - declarationCount(withoutBarrel, name);
    if (used <= 0) dead.push(name);
  }
  return { file, dead };
}

let failed = false;
for (const budget of BUDGETS) {
  const report = await deadExports(budget.file);
  const count = report.dead.length;
  if (count > budget.maximum) {
    failed = true;
    console.error(
      `Unreferenced-export budget exceeded: ${budget.file} has ${count} export(s) with no caller (budget ${budget.maximum}).`,
    );
    console.error(`  ${report.dead.join(", ")}`);
    console.error(
      "  Wire the new helper into the code that ships, or delete it. A unit test is not a caller.",
    );
  } else if (count < budget.maximum) {
    failed = true;
    console.error(
      `Unreferenced-export budget is stale: ${budget.file} now has ${count} (budget ${budget.maximum}).`,
    );
    console.error(
      `  Lower the budget in scripts/check-unreferenced-exports.ts to ${count} to keep the ratchet tight.`,
    );
  }
}

if (failed) process.exit(1);
console.log(
  `Unreferenced-export check passed (${BUDGETS.length} file(s) within budget).`,
);
