#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonBytes,
  parseCanonicalJson,
  type CanonicalJsonValue,
} from "../core/adapters/takoform/canonical_json.ts";
import {
  loadReviewedPublishedPackageInstallSet,
  REVIEWED_TAKOFORM_PACKAGE_KINDS,
  type ReviewedPublishedPackageInstallSet,
} from "./verify-takoform-published-package-host-proof.ts";

const TAKOSUMI_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(
  /\/$/u,
  "",
);
const MANIFEST_FILE = "install-envelope-manifest.json";
const TRUSTED_ROOT_FILE = "trusted-root.json";
const TRUSTED_ROOT_R2_KEY = "trust/sigstore-public-good-root.json";
const MAX_ENVELOPE_BYTES = 32 << 20;
const MAX_TRUSTED_ROOT_BYTES = 4 << 20;

export interface PrepareInstallEnvelopesOptions {
  readonly takoformRoot: string;
  readonly outputDir: string;
}

export interface PrepareInstallEnvelopesResult {
  readonly format: "takosumi.takoform-install-envelope-output@v1";
  readonly outputDir: string;
  readonly manifestFile: typeof MANIFEST_FILE;
  readonly packageCount: number;
  readonly verifierId: string;
}

interface PrepareInstallEnvelopesDependencies {
  readonly loadReviewedSet?: (
    takoformRoot: string,
  ) => Promise<ReviewedPublishedPackageInstallSet>;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
  process.exit(exitCode);
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  const result = await prepareInstallEnvelopes(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Prepared ${result.packageCount} verified Takoform install envelopes in ${result.outputDir}.`,
    );
  }
  return 0;
}

export async function prepareInstallEnvelopes(
  options: PrepareInstallEnvelopesOptions,
  dependencies: PrepareInstallEnvelopesDependencies = {},
): Promise<PrepareInstallEnvelopesResult> {
  const outputDir = await validateOutputPath(options);
  const loadReviewedSet =
    dependencies.loadReviewedSet ?? loadReviewedPublishedPackageInstallSet;

  // The retained checkout, every package envelope, and the actual host
  // signature/data-only verifier all pass before an output directory exists.
  const reviewed = await loadReviewedSet(options.takoformRoot);
  const files = buildOutputFiles(reviewed);
  await publishDirectoryAtomically(outputDir, files);
  return {
    format: "takosumi.takoform-install-envelope-output@v1",
    outputDir,
    manifestFile: MANIFEST_FILE,
    packageCount: reviewed.packages.length,
    verifierId: reviewed.verifierId,
  };
}

function buildOutputFiles(
  reviewed: ReviewedPublishedPackageInstallSet,
): ReadonlyMap<string, Uint8Array> {
  if (
    reviewed.format !== "takosumi.reviewed-takoform-package-install-set@v1" ||
    reviewed.packages.length !== REVIEWED_TAKOFORM_PACKAGE_KINDS.length ||
    !sameStrings(
      reviewed.packages.map(({ kind }) => kind),
      REVIEWED_TAKOFORM_PACKAGE_KINDS,
    ) ||
    !/^[a-f0-9]{40}$/u.test(reviewed.checkoutCommit) ||
    !/^[a-f0-9]{40}$/u.test(reviewed.releaseCommit)
  ) {
    throw new Error("reviewed Takoform install set is incomplete");
  }
  if (
    reviewed.trustedRoot.bytes.byteLength === 0 ||
    reviewed.trustedRoot.bytes.byteLength > MAX_TRUSTED_ROOT_BYTES ||
    sha256(reviewed.trustedRoot.bytes) !== reviewed.trustedRoot.digest
  ) {
    throw new Error("reviewed TrustedRoot bytes do not match their pin");
  }

  const files = new Map<string, Uint8Array>();
  const manifestPackages: CanonicalJsonValue[] = [];
  const kinds = new Set<string>();
  for (const entry of [...reviewed.packages].sort((left, right) =>
    left.kind.localeCompare(right.kind),
  )) {
    if (
      kinds.has(entry.kind) ||
      entry.envelopeBytes.byteLength === 0 ||
      entry.envelopeBytes.byteLength > MAX_ENVELOPE_BYTES ||
      !/^sha256:[a-f0-9]{64}$/u.test(entry.packageDigest)
    ) {
      throw new Error(`${entry.kind} reviewed envelope is invalid`);
    }
    kinds.add(entry.kind);
    assertCanonical(entry.envelopeBytes, `${entry.kind} install envelope`);

    const slug = kindSlug(entry.kind);
    const envelopeFile = `${slug}.install-envelope.json`;
    const installRequestFile = `${slug}.install-request.json`;
    const reverifyRequestFile = `${slug}.reverify-request.json`;
    const envelopeDigest = sha256(entry.envelopeBytes);
    const envelopeDigestHex = envelopeDigest.slice("sha256:".length);
    const r2Key = [
      "packages",
      "takoform",
      reviewed.packageVersion,
      slug,
      `${envelopeDigestHex}.json`,
    ].join("/");
    const installRequest = {
      artifactRef: `r2:${r2Key}`,
      expectedPackageDigest: entry.packageDigest,
    } as const;
    const reverifyRequest = {
      formRef: entry.formRef,
      packageDigest: entry.packageDigest,
    } as const;

    putUnique(files, envelopeFile, entry.envelopeBytes);
    putUnique(
      files,
      installRequestFile,
      canonicalJsonBytes(installRequest as CanonicalJsonValue),
    );
    putUnique(
      files,
      reverifyRequestFile,
      canonicalJsonBytes(reverifyRequest as CanonicalJsonValue),
    );
    manifestPackages.push({
      kind: entry.kind,
      releaseTag: entry.releaseTag,
      packageDigest: entry.packageDigest,
      formRef: entry.formRef,
      envelopeDigest,
      envelopeSize: entry.envelopeBytes.byteLength,
      envelopeFile,
      r2Key,
      installRequest: {
        file: installRequestFile,
        body: installRequest,
      },
      reverifyRequest: {
        file: reverifyRequestFile,
        body: reverifyRequest,
      },
    } as CanonicalJsonValue);
  }

  putUnique(files, TRUSTED_ROOT_FILE, reviewed.trustedRoot.bytes);
  const manifest = canonicalJsonBytes({
    format: "takosumi.takoform-install-envelope-set@v1",
    repository: reviewed.repository,
    packageVersion: reviewed.packageVersion,
    definitionVersion: reviewed.definitionVersion,
    verifierId: reviewed.verifierId,
    pins: {
      checkoutCommit: reviewed.checkoutCommit,
      releaseCommit: reviewed.releaseCommit,
      publishedSet: reviewed.publishedSet,
      publishedTrust: reviewed.publishedTrust,
      packageIndexPolicy: reviewed.packageIndexPolicy,
      trustedRoot: {
        path: reviewed.trustedRoot.path,
        digest: reviewed.trustedRoot.digest,
      },
    },
    publisher: reviewed.publisher,
    trustedRoot: {
      file: TRUSTED_ROOT_FILE,
      digest: reviewed.trustedRoot.digest,
      r2Key: TRUSTED_ROOT_R2_KEY,
    },
    packages: manifestPackages,
  } as CanonicalJsonValue);
  putUnique(files, MANIFEST_FILE, manifest);
  return files;
}

async function validateOutputPath(
  options: PrepareInstallEnvelopesOptions,
): Promise<string> {
  if (!isAbsolute(options.takoformRoot)) {
    throw new Error("--takoform-root must be an absolute path");
  }
  if (!isAbsolute(options.outputDir)) {
    throw new Error("--output-dir must be an absolute path");
  }
  const requestedTakoformRoot = resolve(options.takoformRoot);
  const rootStatus = await lstat(requestedTakoformRoot);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("--takoform-root must be a real directory");
  }
  const takoformRoot = await realpath(requestedTakoformRoot);
  if (
    requestedTakoformRoot !== options.takoformRoot ||
    takoformRoot !== requestedTakoformRoot
  ) {
    throw new Error("--takoform-root must be a canonical non-symlink path");
  }
  const outputDir = resolve(options.outputDir);
  if (outputDir !== options.outputDir || basename(outputDir).startsWith(".")) {
    throw new Error("--output-dir must be a canonical non-hidden path");
  }
  const outputParent = dirname(outputDir);
  const canonicalParent = await realpath(outputParent);
  if (canonicalParent !== outputParent) {
    throw new Error("--output-dir parent must not traverse a symlink");
  }
  const parentStatus = await lstat(canonicalParent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error("--output-dir parent must be a real directory");
  }
  if (await pathExists(outputDir)) {
    throw new Error("--output-dir already exists; refusing to overwrite it");
  }
  const takosumiRoot = await realpath(TAKOSUMI_ROOT);
  if (isWithin(takosumiRoot, outputDir) || isWithin(takoformRoot, outputDir)) {
    throw new Error("--output-dir must be outside source repositories");
  }
  const currentUid = process.getuid?.();
  if (
    currentUid === undefined ||
    parentStatus.uid !== currentUid ||
    (parentStatus.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "--output-dir parent must be owned by the current user with mode 0700",
    );
  }
  return outputDir;
}

async function publishDirectoryAtomically(
  outputDir: string,
  files: ReadonlyMap<string, Uint8Array>,
): Promise<void> {
  const outputParent = dirname(outputDir);
  const temporaryDir = resolve(
    outputParent,
    `.${basename(outputDir)}.tmp-${process.pid}-${randomUUID()}`,
  );
  await mkdir(temporaryDir, { mode: 0o700 });
  await chmod(temporaryDir, 0o700);
  let moved = false;
  let published = false;
  try {
    for (const [name, bytes] of files) {
      assertFlatOutputName(name);
      await writePrivateFile(resolve(temporaryDir, name), bytes);
    }
    await syncDirectory(temporaryDir);
    await moveDirectoryNoReplace(temporaryDir, outputDir);
    moved = true;
    await syncDirectory(outputParent);
    await assertPublishedModes(outputDir, files.keys());
    published = true;
  } finally {
    if (!published) await rm(temporaryDir, { recursive: true, force: true });
    if (moved && !published) {
      await rm(outputDir, { recursive: true, force: true });
    }
  }
}

async function writePrivateFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function moveDirectoryNoReplace(
  source: string,
  destination: string,
): Promise<void> {
  const child = Bun.spawn(
    ["mv", "--no-clobber", "--no-target-directory", source, destination],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (
    exitCode !== 0 ||
    (await pathExists(source)) ||
    !(await pathExists(destination))
  ) {
    throw new Error(
      `atomic no-overwrite publish failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
}

async function assertPublishedModes(
  outputDir: string,
  names: Iterable<string>,
): Promise<void> {
  const directoryStatus = await lstat(outputDir);
  if (
    !directoryStatus.isDirectory() ||
    directoryStatus.isSymbolicLink() ||
    (directoryStatus.mode & 0o777) !== 0o700
  ) {
    throw new Error("published output directory mode drifted from 0700");
  }
  for (const name of names) {
    const status = await lstat(resolve(outputDir, name));
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      (status.mode & 0o777) !== 0o600
    ) {
      throw new Error(`published output file mode drifted from 0600: ${name}`);
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseOptions(argv: readonly string[]) {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--json") {
      if (json) throw new Error("duplicate argument: --json");
      json = true;
      continue;
    }
    if (arg !== "--takoform-root" && arg !== "--output-dir") {
      throw new Error(`unexpected argument: ${arg}`);
    }
    if (values.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg, value);
    index += 1;
  }
  const takoformRoot = values.get("--takoform-root");
  const outputDir = values.get("--output-dir");
  if (!takoformRoot) {
    throw new Error("--takoform-root <retained-checkout> is required");
  }
  if (!outputDir) throw new Error("--output-dir <new-directory> is required");
  return { takoformRoot, outputDir, json };
}

function assertCanonical(bytes: Uint8Array, label: string): void {
  const canonical = canonicalJsonBytes(parseCanonicalJson(bytes));
  if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
    throw new Error(`${label} is not canonical JSON`);
  }
}

function putUnique(
  files: Map<string, Uint8Array>,
  name: string,
  bytes: Uint8Array,
): void {
  assertFlatOutputName(name);
  if (files.has(name)) throw new Error(`duplicate output file: ${name}`);
  files.set(name, bytes);
}

function assertFlatOutputName(name: string): void {
  if (!/^[a-z0-9][a-z0-9.-]*\.json$/u.test(name)) {
    throw new Error(`unsafe output file name: ${name}`);
  }
}

function kindSlug(kind: string): string {
  const slug = kind
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/u.test(slug)) {
    throw new Error(`unsafe package kind: ${kind}`);
  }
  return slug;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
