import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const FORMAT = "takosumi.standard-form-runtime@v1";
const RELEASE_FORMAT = "takosumi.standard-form-runtime-release@v1";
const VERSION = "1.0.1";
const RELEASE_TAG = `standard-form-runtime-v${VERSION}`;
const SOURCE_ROOT = `conformance/standard-form-runtime/v${VERSION}`;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const EXPECTED_ASSETS = ["durable-workflow.mjs", "edge-worker.mjs"] as const;
const OCI_REFERENCE =
  "docker.io/library/nginx@sha256:845b5424415de5f77dd5753cbb7c1be8bd8e44cc81f20f9705783a02f8848317";

interface RuntimeAsset {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
}

interface ExternalArtifact {
  readonly name: string;
  readonly mediaType: string;
  readonly reference: string;
  readonly digest: string;
  readonly platform: string;
}

export interface RuntimeManifest {
  readonly format: string;
  readonly version: string;
  readonly releaseTag: string;
  readonly sourceStatus: string;
  readonly hostConformanceOnly: boolean;
  readonly assets: readonly RuntimeAsset[];
  readonly externalArtifacts: readonly ExternalArtifact[];
}

export async function verifyRuntimeArtifacts(
  repoRoot: string,
  options: { readonly verifyOci?: boolean } = {},
): Promise<RuntimeManifest> {
  const sourceRoot = resolve(repoRoot, SOURCE_ROOT);
  const manifestPath = join(sourceRoot, "runtime-manifest.json");
  const manifest = object(
    JSON.parse(await readFile(manifestPath, "utf8")),
    "runtime manifest",
  ) as unknown as RuntimeManifest;
  exactKeys(
    manifest as unknown as Record<string, unknown>,
    [
      "assets",
      "externalArtifacts",
      "format",
      "hostConformanceOnly",
      "releaseTag",
      "sourceStatus",
      "version",
    ],
    "runtime manifest",
  );
  if (
    manifest.format !== FORMAT ||
    manifest.version !== VERSION ||
    manifest.releaseTag !== RELEASE_TAG ||
    manifest.sourceStatus !== "candidate-only" ||
    manifest.hostConformanceOnly !== true
  ) {
    throw new Error("runtime manifest identity or publication boundary is invalid");
  }

  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 2) {
    throw new Error("runtime manifest must contain exactly two local assets");
  }
  const seen = new Set<string>();
  for (const rawAsset of manifest.assets) {
    const asset = object(rawAsset, "runtime asset") as unknown as RuntimeAsset;
    exactKeys(
      asset as unknown as Record<string, unknown>,
      ["mediaType", "name", "sha256", "size"],
      `runtime asset ${asset.name}`,
    );
    if (
      !EXPECTED_ASSETS.includes(asset.name as (typeof EXPECTED_ASSETS)[number]) ||
      asset.mediaType !== "text/javascript" ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !SHA256.test(asset.sha256) ||
      seen.has(asset.name)
    ) {
      throw new Error(`runtime asset ${String(asset.name)} identity is invalid`);
    }
    const path = join(sourceRoot, asset.name);
    if (basename(path) !== asset.name || !(await stat(path)).isFile()) {
      throw new Error(`runtime asset ${asset.name} path is not a regular file`);
    }
    const bytes = await readFile(path);
    if (bytes.byteLength !== asset.size || digest(bytes) !== asset.sha256) {
      throw new Error(`runtime asset ${asset.name} bytes do not match the manifest`);
    }
    const source = bytes.toString("utf8");
    if (
      (asset.name === "edge-worker.mjs" && !source.includes("export default")) ||
      (asset.name === "durable-workflow.mjs" &&
        !source.includes("export class IngestWorkflow"))
    ) {
      throw new Error(`runtime asset ${asset.name} omits its required entrypoint`);
    }
    seen.add(asset.name);
  }
  if (EXPECTED_ASSETS.some((name) => !seen.has(name))) {
    throw new Error("runtime manifest asset closure is incomplete");
  }

  if (
    !Array.isArray(manifest.externalArtifacts) ||
    manifest.externalArtifacts.length !== 1
  ) {
    throw new Error("runtime manifest must contain exactly one external OCI artifact");
  }
  const external = object(
    manifest.externalArtifacts[0],
    "external OCI artifact",
  ) as unknown as ExternalArtifact;
  exactKeys(
    external as unknown as Record<string, unknown>,
    ["digest", "mediaType", "name", "platform", "reference"],
    "external OCI artifact",
  );
  if (
    external.name !== "container-service" ||
    external.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    external.reference !== OCI_REFERENCE ||
    external.digest !== `sha256:${OCI_REFERENCE.split("@sha256:")[1]}` ||
    external.platform !== "linux/amd64" ||
    !SHA256.test(external.digest)
  ) {
    throw new Error("external OCI artifact is not the reviewed linux/amd64 digest");
  }
  if (options.verifyOci) await verifyOciManifest(external);
  return manifest;
}

export async function buildRuntimeRelease(
  repoRoot: string,
  sourceCommit: string,
  output: string,
): Promise<void> {
  if (!COMMIT.test(sourceCommit)) throw new Error("source commit must be a 40-character SHA-1");
  const manifest = await verifyRuntimeArtifacts(repoRoot);
  await mkdir(output, { recursive: true, mode: 0o755 });
  if ((await readdir(output)).length !== 0) {
    throw new Error("release output directory must be empty");
  }
  const sourceRoot = resolve(repoRoot, SOURCE_ROOT);
  for (const asset of manifest.assets) {
    await copyFile(join(sourceRoot, asset.name), join(output, asset.name));
  }
  await copyFile(
    join(sourceRoot, "runtime-manifest.json"),
    join(output, "runtime-manifest.json"),
  );
  const releaseAssets = await Promise.all(
    [...manifest.assets.map(({ name, mediaType }) => ({ name, mediaType })), {
      name: "runtime-manifest.json",
      mediaType: "application/json",
    }].map(async ({ name, mediaType }) => {
      const bytes = await readFile(join(output, name));
      return { name, mediaType, size: bytes.byteLength, sha256: digest(bytes) };
    }),
  );
  releaseAssets.sort((left, right) => left.name.localeCompare(right.name));
  const releaseManifest = {
    format: RELEASE_FORMAT,
    version: VERSION,
    releaseTag: RELEASE_TAG,
    sourceRepository: "github.com/tako0614/takosumi",
    sourceCommit,
    publicationStatus: "pending-immutable-publication",
    hostConformanceOnly: true,
    assets: releaseAssets,
    externalArtifacts: manifest.externalArtifacts,
  };
  await writeFile(
    join(output, "release-manifest.json"),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    { mode: 0o644 },
  );
}

async function verifyOciManifest(external: ExternalArtifact): Promise<void> {
  const process = Bun.spawn(
    ["docker", "buildx", "imagetools", "inspect", external.reference, "--raw"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [raw, stderr, status] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (status !== 0) {
    throw new Error(`OCI registry readback failed: ${stderr.trim()}`);
  }
  if (digest(new Uint8Array(raw)) !== external.digest) {
    throw new Error("OCI registry readback digest does not match the retained reference");
  }
  const manifest = object(
    JSON.parse(new TextDecoder().decode(raw)),
    "OCI manifest",
  );
  if (manifest.mediaType !== external.mediaType) {
    throw new Error("OCI registry readback media type does not match the retained reference");
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys are not closed`);
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    const unexpected = args.filter((value) => value !== "--verify-oci");
    if (unexpected.length !== 0) throw new Error(`unknown check argument ${unexpected[0]}`);
    await verifyRuntimeArtifacts(process.cwd(), {
      verifyOci: args.includes("--verify-oci"),
    });
    console.log(`standard-form runtime ${VERSION}: candidate verified`);
    return;
  }
  if (command === "build-release") {
    const sourceCommit = option(args, "--source-commit");
    const output = option(args, "--output");
    await buildRuntimeRelease(process.cwd(), sourceCommit, resolve(output));
    console.log(`standard-form runtime ${VERSION}: release candidate built`);
    return;
  }
  throw new Error(
    "usage: bun scripts/verify-standard-form-runtime-artifacts.ts check [--verify-oci] | build-release --source-commit <sha> --output <dir>",
  );
}

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args.filter((value) => value === name).length !== 1) {
    throw new Error(`${name} is required exactly once`);
  }
  const allowed = new Set(["--source-commit", "--output"]);
  for (let cursor = 0; cursor < args.length; cursor += 2) {
    if (!allowed.has(args[cursor] ?? "") || !args[cursor + 1]) {
      throw new Error(`unknown build-release argument ${args[cursor] ?? ""}`);
    }
  }
  return args[index + 1]!;
}

if (import.meta.main) {
  await main();
}
