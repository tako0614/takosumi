/**
 * Preflight: an absent capability is a refusal, never a skip.
 *
 * WHY. `tests/scripts/prove-live-opentofu-plan-apply_test.ts` ran the live
 * OpenTofu plan/apply proof under `test.skipIf(!hasTofu)`. On a machine without
 * `tofu` the complete owner gate printed the same green line it prints when the
 * proof passes, so the output said nothing about whether the thing was checked.
 * That is the failure mode the ecosystem rule names: a capability that is
 * absent is not a capability that passed.
 *
 * So the gate resolves what it needs FIRST, and refuses with exit 127 —
 * "command not found", the shell's own vocabulary — naming every missing tool
 * at once rather than one per re-run. The reference is
 * terraform-provider-takoform's `check:tools`.
 *
 * Only tools the portable gate itself invokes from PATH belong here. A
 * dependency resolved through `node_modules` is the lockfile's problem, and a
 * live service is a different cadence entirely.
 *
 * Run: `bun scripts/check-tools.ts`
 */

export interface RequiredTool {
  readonly command: string;
  readonly why: string;
}

export const REQUIRED_TOOLS: readonly RequiredTool[] = [
  {
    command: "git",
    why: "the deploy lineage predicate and its corpus tests run real git over real checkouts",
  },
  {
    command: "tofu",
    why: "the live local OpenTofu plan/apply/destroy proof is part of the portable gate, not an optional extra",
  },
  {
    command: "bash",
    why: "the dashboard docs build step (`scripts/build-app-docs.sh`) is a shell script",
  },
];

export async function missingTools(
  tools: readonly RequiredTool[] = REQUIRED_TOOLS,
  resolves: (command: string) => Promise<boolean> = commandResolves,
): Promise<readonly RequiredTool[]> {
  const missing: RequiredTool[] = [];
  for (const tool of tools) {
    if (!(await resolves(tool.command))) missing.push(tool);
  }
  return missing;
}

async function commandResolves(command: string): Promise<boolean> {
  // `command -v` is a shell builtin, so it needs a shell. Bun.which resolves
  // PATH directly and does not, which keeps the probe honest when even `sh`
  // is what is missing.
  if (Bun.which(command) !== null) return true;
  try {
    const shell = Bun.spawn(["sh", "-c", `command -v ${command}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await shell.exited) === 0;
  } catch {
    // No shell either. That is an answer, not an error to propagate: the
    // refusal below is more useful than a stack trace.
    return false;
  }
}

if (import.meta.main) {
  const missing = await missingTools();
  if (missing.length > 0) {
    process.stderr.write(
      "the complete gate cannot run: required tools are not on PATH\n",
    );
    for (const tool of missing) {
      process.stderr.write(`- ${tool.command}: ${tool.why}\n`);
    }
    process.stderr.write(
      "\nInstall them and re-run. The gate refuses rather than skipping the\n" +
        "checks that need them, because a skipped check and a passing check\n" +
        "print the same green line.\n",
    );
    process.exit(127);
  }
  process.stdout.write(
    `tools ok: ${REQUIRED_TOOLS.map((tool) => tool.command).join(", ")}\n`,
  );
}
