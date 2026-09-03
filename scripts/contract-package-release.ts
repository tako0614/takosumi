import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { requireCleanPushedSource } from "./lib/deploy-lineage.ts";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = resolve(REPOSITORY, "contract");
const PACKAGE_NAME = "@takosjp/takosumi-contract";
const SURFACE = "takosumi-contract-package";
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

interface PackageCandidate {
  readonly version: string;
  readonly tarballPath: string;
  readonly integrity: string;
  readonly files: readonly string[];
  readonly decision: "publish" | "skip";
}

export function requiredContractReleaseTag(version: string): string {
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(`contract package version must be stable semver: ${version}`);
  }
  return `takosumi-contract-v${version}`;
}

export function packageReleaseDecision(
  candidateIntegrity: string,
  publishedIntegrity: string | undefined,
): "publish" | "skip" {
  if (publishedIntegrity === undefined) return "publish";
  if (publishedIntegrity === candidateIntegrity) return "skip";
  throw new Error(
    `published package integrity ${publishedIntegrity} does not match candidate ${candidateIntegrity}`,
  );
}

export async function runContractPackageRelease(args: readonly string[]): Promise<void> {
  if (args.length !== 0) {
    throw new Error(`usage: bun run deploy -- ${SURFACE}`);
  }

  const manifest = JSON.parse(await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
    readonly name?: string;
    readonly version?: string;
  };
  if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== "string") {
    throw new Error(`contract/package.json must declare ${PACKAGE_NAME} and a version`);
  }
  const version = manifest.version;
  const tag = requiredContractReleaseTag(version);

  // The shared `published-identity` lineage class: clean, on main, at or an
  // ancestor of a freshly fetched origin/main, AND the tag already on origin at
  // that commit. Hoisted onto scripts/lib/deploy-lineage.ts so control's corpus
  // exercises the same function this publication is guarded by; it also fixed a
  // real gap here, which accepted any branch.
  await requireCleanPushedSource("published-identity", {
    cwd: REPOSITORY,
    tag,
  });
  const commit = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  // Tightening this surface adds: an immutable npm identity is cut from the
  // exact remote tip, never from an older ancestor of it.
  const remoteBranchCommit = git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)
    .split(/\s+/u)[0];
  if (remoteBranchCommit !== commit) {
    throw new Error(
      `deploy blocked before publication: HEAD ${commit} is not the exact pushed remote branch commit ${remoteBranchCommit ?? "missing"}`,
    );
  }

  process.stdout.write(`source ${commit} (${branch}, ${tag})\n\n==> bun run check\n`);
  runChecked("bun", ["run", "check"], REPOSITORY);

  const tempRoot = await mkdtemp(join(tmpdir(), "takosumi-contract-release-"));
  let mutationAttempted = false;
  let candidate: PackageCandidate | null = null;
  try {
    candidate = await prepareCandidate(version, tempRoot);
    assertSafePackageFiles(candidate.files);
    process.stdout.write(
      `\ncandidate ${PACKAGE_NAME}@${version} ${candidate.integrity} (${candidate.decision})\n`,
    );

    process.stdout.write("\n==> exact-tarball consumer check\n");
    await checkConsumer(tempRoot, `file:${candidate.tarballPath}`, "candidate");

    const whoami = run("npm", ["whoami"], REPOSITORY);
    if (whoami.status !== 0) {
      throw new Error(`npm authentication preflight failed:\n${whoami.stderr || whoami.stdout}`);
    }

    let action = "skipped";
    if (candidate.decision === "publish") {
      mutationAttempted = true;
      const published = run(
        "npm",
        ["publish", candidate.tarballPath, "--access", "public", "--ignore-scripts"],
        PACKAGE_ROOT,
      );
      if (published.status !== 0) {
        const raced = await publishedPackageIntegrity(version);
        if (raced !== candidate.integrity) {
          throw new Error(
            `npm publish failed for ${PACKAGE_NAME}@${version}:\n${published.stderr || published.stdout}`,
          );
        }
        action = "concurrent-exact";
      } else {
        action = "published";
      }
    }

    await verifyPublishedIntegrity(version, candidate.integrity);
    process.stdout.write("\n==> registry consumer readback\n");
    await checkConsumer(tempRoot, version, "registry");
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "takos.deploy-result@v1",
          surface: SURFACE,
          target: `npm:${PACKAGE_NAME}`,
          commit,
          tag,
          version,
          integrity: candidate.integrity,
          action,
          registryConsumer: "PASSED",
          status: "PUBLISHED",
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const state = mutationAttempted ? "indeterminate" : "untouched";
    throw new Error(
      `${detail}\nregistry state is ${state}; do not retry without reconciling the exact registry integrity` +
        (candidate === null ? "" : ` ${candidate.integrity}`),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function prepareCandidate(version: string, destination: string): Promise<PackageCandidate> {
  const versions = await publishedVersions();
  const publishedIntegrity = await publishedPackageIntegrity(version);
  if (publishedIntegrity === undefined) assertVersionAdvances(version, versions);

  const packed = run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    PACKAGE_ROOT,
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed:\n${packed.stderr || packed.stdout}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(packed.stdout);
  } catch {
    throw new Error(`npm pack returned invalid JSON:\n${packed.stdout}`);
  }
  if (!Array.isArray(report) || report.length !== 1 || !isRecord(report[0])) {
    throw new Error("npm pack returned an unexpected report");
  }
  const entry = report[0];
  if (typeof entry.filename !== "string" || typeof entry.integrity !== "string") {
    throw new Error("npm pack omitted filename or integrity");
  }
  const files = Array.isArray(entry.files)
    ? entry.files
        .filter(isRecord)
        .map((file) => file.path)
        .filter((path): path is string => typeof path === "string")
    : [];
  return {
    version,
    tarballPath: resolve(destination, entry.filename),
    integrity: entry.integrity,
    files,
    decision: packageReleaseDecision(entry.integrity, publishedIntegrity),
  };
}

function assertSafePackageFiles(files: readonly string[]): void {
  const unsafe = files.filter((path) =>
    /(^|\/)\.env(?:\.|$)|\.(?:pem|key|crt|cer|p12|pfx)$/iu.test(path),
  );
  if (unsafe.length > 0) {
    throw new Error(`contract tarball contains credential-shaped files:\n${unsafe.join("\n")}`);
  }
}

async function checkConsumer(root: string, dependency: string, name: string): Promise<void> {
  const directory = resolve(root, `consumer-${name}`);
  await mkdir(directory);
  await Promise.all([
    writeFile(
      resolve(directory, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: { [PACKAGE_NAME]: dependency },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      resolve(directory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            allowImportingTsExtensions: true,
            lib: ["ESNext", "DOM"],
            module: "Preserve",
            moduleResolution: "Bundler",
            noEmit: true,
            strict: true,
            target: "ESNext",
            types: [],
            verbatimModuleSyntax: true,
          },
          include: ["smoke.ts"],
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(resolve(directory, "smoke.ts"), await consumerSmokeSource()),
  ]);
  runChecked("bun", ["install", "--ignore-scripts"], directory);
  runChecked(resolve(REPOSITORY, "node_modules/.bin/tsc"), ["--project", "tsconfig.json"], directory);
  runChecked("bun", ["smoke.ts"], directory);
}

/**
 * The consumer check imports EVERY declared export subpath.
 *
 * Derived, not listed: the previous smoke module named three subpaths by hand,
 * so a subpath whose target the package did not ship was published and only
 * found by the consumer who tried to import it. Deriving the check from the
 * same `exports` map the package publishes means adding an export adds its own
 * proof.
 */
async function consumerSmokeSource(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8"),
  ) as { readonly exports?: Readonly<Record<string, string>> };
  const subpaths = Object.keys(manifest.exports ?? {});
  if (subpaths.length === 0) {
    throw new Error("contract/package.json declares no exports to verify");
  }
  const imports: string[] = [
    `import { createTakosumiWellKnownDocument } from "${PACKAGE_NAME}/discovery";`,
    `import { TAKOSUMI_ACCOUNTS_USERINFO_PATH } from "${PACKAGE_NAME}/identity-oidc";`,
  ];
  subpaths.forEach((subpath, index) => {
    const specifier =
      subpath === "." ? PACKAGE_NAME : `${PACKAGE_NAME}${subpath.slice(1)}`;
    imports.push(`import * as module${index} from "${specifier}";`);
  });
  const body = [
    `const modules: unknown[] = [${subpaths
      .map((_, index) => `module${index}`)
      .join(", ")}];`,
    `if (modules.length !== ${subpaths.length}) throw new Error("export subpath count changed");`,
    "for (const module of modules) {",
    '  if (typeof module !== "object" || module === null) {',
    '    throw new Error("an exported subpath did not resolve to a module");',
    "  }",
    "}",
    // Two value assertions so the check is not satisfied by empty modules.
    'const discovery = createTakosumiWellKnownDocument({ origin: "https://host.example" });',
    'if (discovery.apiBaseUrl !== "https://host.example/api/v1") throw new Error("bad discovery");',
    'if (TAKOSUMI_ACCOUNTS_USERINFO_PATH !== "/oauth/userinfo") throw new Error("bad OIDC path");',
  ];
  return `${[...imports, "", ...body].join("\n")}\n`;
}

async function publishedPackageIntegrity(version: string): Promise<string | undefined> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`,
    { headers: { accept: "application/json" } },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`npm registry read failed: HTTP ${response.status}`);
  const metadata = (await response.json()) as { readonly dist?: { readonly integrity?: unknown } };
  if (typeof metadata.dist?.integrity !== "string") {
    throw new Error(`${PACKAGE_NAME}@${version} has no registry integrity`);
  }
  return metadata.dist.integrity;
}

async function publishedVersions(): Promise<readonly string[]> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`npm registry inventory failed: HTTP ${response.status}`);
  const metadata = (await response.json()) as { readonly versions?: unknown };
  if (!isRecord(metadata.versions)) throw new Error("npm registry returned no version inventory");
  return Object.keys(metadata.versions);
}

function assertVersionAdvances(version: string, published: readonly string[]): void {
  const candidate = parseStableVersion(version);
  const latest = published
    .flatMap((entry) => (STABLE_SEMVER.test(entry) ? [parseStableVersion(entry)] : []))
    .sort(compareVersion)
    .at(-1);
  if (latest !== undefined && compareVersion(candidate, latest) <= 0) {
    throw new Error(`${version} does not advance published version ${latest.raw}`);
  }
}

interface StableVersion {
  readonly raw: string;
  readonly parts: readonly [number, number, number];
}

function parseStableVersion(version: string): StableVersion {
  const match = STABLE_SEMVER.exec(version);
  if (match === null) throw new Error(`version must be stable semver: ${version}`);
  return { raw: version, parts: [Number(match[1]), Number(match[2]), Number(match[3])] };
}

function compareVersion(left: StableVersion, right: StableVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function verifyPublishedIntegrity(version: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await Bun.sleep(1_000);
    const actual = await publishedPackageIntegrity(version);
    if (actual === undefined) continue;
    packageReleaseDecision(expected, actual);
    return;
  }
  throw new Error(`npm did not expose ${PACKAGE_NAME}@${version} with the candidate integrity`);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: REPOSITORY, encoding: "utf8" }).trim();
}

function run(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runChecked(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
