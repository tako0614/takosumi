import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult, TestStep } from "@playwright/test/reporter";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
const SOURCE = join(ROOT, "tests/dashboard/e2e");
const sourceNames = new Map(readdirSync(SOURCE).filter((name) => name.endsWith(".ts"))
  .map((name) => [join(SOURCE, name), name]));
const categories = new Set(["expect", "fixture", "hook", "pw:api", "test.step", "test.attach"]);
const statuses = new Set(["passed", "failed", "timedOut", "timedout", "skipped", "interrupted"]);

/** Live profiles never collect timing evidence, even when this env is inherited. */
export function dashboardTimingReporters(mode: string, outputDir?: string):
  "line" | [["line"], [string, { outputDir: string }]] {
  return mode === "portable" && outputDir
    ? [["line"], [fileURLToPath(import.meta.url), { outputDir }]]
    : "line";
}

function sourceLocation(location: TestCase["location"] | undefined) {
  const file = location && sourceNames.get(location.file);
  return file && Number.isSafeInteger(location!.line) && location!.line > 0
    ? { file, line: location!.line }
    : undefined;
}

const duration = (value: number) => Number.isFinite(value) && value >= 0 ? value : null;
const status = (value: string) => statuses.has(value) ? value : "unknown";

/** Deliberate projection: never serialize titles, errors, arguments or attachments. */
export function projectDashboardStep(step: TestStep): object {
  const durationMs = duration(step.duration);
  return {
    category: categories.has(step.category) ? step.category : "other",
    source: sourceLocation(step.location),
    durationMs,
    status: step.error ? "failed" : durationMs === null ? "unknown" : "passed",
    steps: step.steps.map(projectDashboardStep),
  };
}

function privateDirectory(value: string): string {
  if (!isAbsolute(value)) throw new Error("dashboard timing directory must be absolute");
  const info = lstatSync(value);
  const directory = realpathSync(value);
  const path = relative(ROOT, directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 ||
    !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))) {
    throw new Error("dashboard timing directory must be owned, private and outside the checkout");
  }
  for (const name of ["timings.json", "provenance.json"]) {
    if (lstatSync(join(directory, name), { throwIfNoEntry: false })) {
      throw new Error("dashboard timing output must not already exist");
    }
  }
  return directory;
}

/** One job-private, metadata-only report, alongside the unchanged line reporter. */
export default class DashboardTimingReporter implements Reporter {
  private readonly directory: string;
  private readonly cases: object[] = [];
  private selectedCases = 0;

  constructor(options: { outputDir: string }) {
    this.directory = privateDirectory(options.outputDir);
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.selectedCases = suite.allTests().length;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.cases.push({
      case: this.cases.length + 1,
      source: sourceLocation(test.location),
      durationMs: duration(result.duration),
      status: status(result.status),
      expectedStatus: status(test.expectedStatus),
      steps: result.steps.map(projectDashboardStep),
    });
  }

  async onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | void> {
    try {
      const text = `${JSON.stringify({ version: 1, mode: "portable", status: status(result.status),
        durationMs: duration(result.duration), selectedCases: this.selectedCases, cases: this.cases }, null, 2)}\n`;
      const [commit, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {
        cwd: ROOT, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }).trim().split("\n");
      if (![commit, tree].every((value) => /^[a-f0-9]{40}$/u.test(value ?? ""))) {
        throw new Error("could not identify dashboard timing source");
      }
      const digits = (value: string | undefined) => value && /^\d+$/u.test(value) ? value : null;
      const playwright = JSON.parse(readFileSync(join(ROOT, "node_modules/@playwright/test/package.json"), "utf8")) as { version: string };
      const provenance = {
        version: 1, source: { commit, tree }, status: status(result.status),
        complete: result.status === "passed" && this.selectedCases > 0 && this.cases.length === this.selectedCases,
        selectedCases: this.selectedCases, cases: this.cases.length,
        measurements: { path: "timings.json", sha256: createHash("sha256").update(text).digest("hex") },
        github: { runId: digits(process.env.GITHUB_RUN_ID), runAttempt: digits(process.env.GITHUB_RUN_ATTEMPT) },
        playwrightVersion: /^\d+\.\d+\.\d+$/u.test(playwright.version) ? playwright.version : null,
      };
      writeFileSync(join(this.directory, "timings.json"), text, { flag: "wx", mode: 0o600 });
      writeFileSync(join(this.directory, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      // Playwright logs and swallows reporter exceptions. Its explicit status
      // override is required to fail a passing run when required evidence fails.
      console.error("dashboard timing evidence could not be saved");
      if (result.status === "passed") return { status: "failed" };
    }
  }
}
