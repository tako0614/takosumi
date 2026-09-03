import { resolve } from "node:path";

export type PortableGatePhase = Readonly<{
  name: string;
  command: readonly string[];
}>;

export type PortableGateRuntime = Readonly<{
  cwd?: string;
  now?: () => number;
  run?: (command: readonly string[], cwd: string) => Promise<number>;
  write?: (line: string) => void;
}>;

export class PortableGateFailure extends Error {
  readonly phase: PortableGatePhase;
  readonly exitCode: number | null;
  readonly durationMilliseconds: number;
  readonly cause: unknown;

  constructor(input: {
    phase: PortableGatePhase;
    exitCode: number | null;
    durationMilliseconds: number;
    cause?: unknown;
  }) {
    const command = input.phase.command.join(" ");
    const status =
      input.exitCode === null
        ? "could not start"
        : `exited with status ${input.exitCode}`;
    super(
      `portable gate phase ${input.phase.name} ${status} after ${formatDuration(input.durationMilliseconds)}: ${command}`,
    );
    this.name = "PortableGateFailure";
    this.phase = input.phase;
    this.exitCode = input.exitCode;
    this.durationMilliseconds = input.durationMilliseconds;
    this.cause = input.cause;
  }
}

/**
 * Keep the complete Takosumi owner gate serial. Each phase corresponds to one
 * command from the package's original `check` script, so nested package
 * scripts retain their own fail-fast behavior and no capability is skipped.
 */
export const PORTABLE_GATE_PHASES: readonly PortableGatePhase[] = [
  phase("format", ["bun", "run", "fmt:check"]),
  phase("package-script-boundaries", [
    "bun",
    "run",
    "check:package-script-boundaries",
  ]),
  phase("production-migrations", [
    "bun",
    "run",
    "check:production-migrations",
  ]),
  phase("no-first-party-provider", [
    "bun",
    "run",
    "check:no-first-party-provider",
  ]),
  phase("platform-bindings", ["bun", "run", "check:platform-bindings"]),
  phase("generated-assets", ["bun", "run", "generated-assets:check"]),
  phase("authoritative-docs", [
    "bun",
    "run",
    "check:authoritative-docs",
  ]),
  phase("import-boundaries", ["bun", "run", "check:import-boundaries"]),
  phase("test-source-boundary", [
    "bun",
    "run",
    "check:test-source-boundary",
  ]),
  phase("generalization-boundaries", [
    "bun",
    "run",
    "check:generalization-boundaries",
  ]),
  phase("tests", ["bun", "run", "test"]),
  phase("typescript", ["tsc", "--noEmit"]),
  phase("dashboard", ["bun", "run", "check:dashboard"]),
  phase("dashboard-browser", ["bun", "run", "check:dashboard-browser"]),
  phase("docs-browser", ["bun", "run", "docs:test:browser"]),
  phase("worker-types", ["bun", "run", "check:worker-types"]),
  phase("cloudflare-worker-build", [
    "bun",
    "run",
    "check:cloudflare-worker-build",
  ]),
];

export function validatePortableGatePhases(
  phases: readonly PortableGatePhase[],
): void {
  const names = new Set<string>();
  for (const current of phases) {
    if (!current.name.trim()) {
      throw new Error("portable gate phase name must not be empty");
    }
    if (names.has(current.name)) {
      throw new Error(`duplicate portable gate phase: ${current.name}`);
    }
    names.add(current.name);
    if (
      current.command.length === 0 ||
      current.command.some((value) => !value)
    ) {
      throw new Error(`portable gate phase has an empty command: ${current.name}`);
    }
  }

  const tscPhases = phases.filter((current) =>
    sameCommand(current.command, ["tsc", "--noEmit"]),
  );
  if (tscPhases.length !== 1) {
    throw new Error(
      `portable gate requires exactly one global TypeScript sweep (found ${tscPhases.length})`,
    );
  }

  const testPhases = phases.filter((current) =>
    sameCommand(current.command, ["bun", "run", "test"]),
  );
  if (testPhases.length !== 1) {
    throw new Error(
      `portable gate requires exactly one global test sweep (found ${testPhases.length})`,
    );
  }
}

export async function runPortableGate(
  runtime: PortableGateRuntime = {},
  phases: readonly PortableGatePhase[] = PORTABLE_GATE_PHASES,
): Promise<void> {
  validatePortableGatePhases(phases);
  const cwd = runtime.cwd ?? resolve(import.meta.dir, "..");
  const now = runtime.now ?? (() => performance.now());
  const write = runtime.write ?? ((line: string) => console.error(line));
  const run = runtime.run ?? runCommand;
  const totalStartedAt = now();

  for (const current of phases) {
    const startedAt = now();
    write(`[portable-check] ▶ ${current.name}: ${current.command.join(" ")}`);
    try {
      const exitCode = await run(current.command, cwd);
      const durationMilliseconds = elapsed(now(), startedAt);
      if (exitCode !== 0) {
        write(
          `[portable-check] ✗ ${current.name} (${formatDuration(durationMilliseconds)}, exit ${exitCode})`,
        );
        throw new PortableGateFailure({
          phase: current,
          exitCode,
          durationMilliseconds,
        });
      }
      write(
        `[portable-check] ✓ ${current.name} (${formatDuration(durationMilliseconds)})`,
      );
    } catch (error) {
      if (error instanceof PortableGateFailure) throw error;
      const durationMilliseconds = elapsed(now(), startedAt);
      write(
        `[portable-check] ✗ ${current.name} (${formatDuration(durationMilliseconds)}, could not start)`,
      );
      throw new PortableGateFailure({
        phase: current,
        exitCode: null,
        durationMilliseconds,
        cause: error,
      });
    }
  }

  write(
    `[portable-check] complete (${formatDuration(elapsed(now(), totalStartedAt))})`,
  );
}

export function formatDuration(milliseconds: number): string {
  return `${(Math.max(0, milliseconds) / 1000).toFixed(2)}s`;
}

function phase(name: string, command: readonly string[]): PortableGatePhase {
  return { name, command };
}

function sameCommand(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function elapsed(now: number, startedAt: number): number {
  return Math.max(0, now - startedAt);
}

async function runCommand(
  command: readonly string[],
  cwd: string,
): Promise<number> {
  const child = Bun.spawn([...command], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

if (import.meta.main) {
  try {
    await runPortableGate();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[portable-check] failed: ${message}`);
    process.exitCode = 1;
  }
}
