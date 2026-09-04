import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

const COMMIT = /^[0-9a-f]{40}$/u;

/**
 * The source identity paired with one operator-owned realized platform config.
 * Source paths never belong in the realized TOML; both release surfaces derive
 * them from the checkout that satisfies this exact repository/commit pin.
 */
export interface PlatformReleaseSourcePin {
  readonly kind: "takosumi.platform-release-source@v1";
  readonly repository: string;
  readonly commit: string;
}

export interface PlatformReleaseSourceAuthority {
  readonly pinPath: string;
  readonly pin: PlatformReleaseSourcePin;
  readonly repositoryRoot: string;
  readonly entryWorkerPath: string;
  readonly dashboardAssetsPath: string;
}

/** `platform/wrangler.staging.toml` -> `platform/wrangler.staging.source.json`. */
export function platformReleaseSourcePinPath(configPath: string): string {
  if (!configPath.endsWith(".toml")) {
    throw new Error("platform_worker_release_config_invalid");
  }
  return `${configPath.slice(0, -".toml".length)}.source.json`;
}

export function parsePlatformReleaseSourcePin(
  text: string,
): PlatformReleaseSourcePin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("platform_worker_release_source_pin_invalid");
  }
  if (
    !record(parsed) ||
    parsed.kind !== "takosumi.platform-release-source@v1" ||
    typeof parsed.repository !== "string" ||
    parsed.repository.trim().length === 0 ||
    parsed.repository.length > 4_096 ||
    typeof parsed.commit !== "string" ||
    !COMMIT.test(parsed.commit) ||
    Object.keys(parsed).sort().join(",") !== "commit,kind,repository"
  ) {
    throw new Error("platform_worker_release_source_pin_invalid");
  }
  return {
    kind: "takosumi.platform-release-source@v1",
    repository: parsed.repository,
    commit: parsed.commit,
  };
}

/** Two spellings of one Git remote are one remote. */
export function sameGitRemote(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/^git\+/u, "")
      .replace(/\.git$/u, "")
      .replace(/\/+$/u, "")
      .replace(/^git@([^:]+):/u, "https://$1/")
      .replace(/^ssh:\/\/git@/u, "https://")
      .toLowerCase();
  return normalize(left) === normalize(right);
}

/** Read the source pin through one stable, no-follow, single-link descriptor. */
export function readPlatformReleaseSourcePin(
  configPath: string,
): PlatformReleaseSourcePin {
  const pinPath = platformReleaseSourcePinPath(configPath);
  const bytes = readStablePhysicalFile(
    pinPath,
    "platform_worker_release_source_pin_invalid",
  );
  try {
    return parsePlatformReleaseSourcePin(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("platform_worker_release_source_pin_invalid");
  }
}

/** A realized release config describes resources and bindings, never paths. */
export function assertPlatformReleaseConfigPathless(source: string): void {
  if (/^\s*main\s*=/mu.test(source) || /^\s*directory\s*=/mu.test(source)) {
    throw new Error("platform_worker_release_config_declares_source_path");
  }
  // TOML also permits quoted and dotted keys. Keep the textual fail-closed
  // screen above (including its historical rejection of a stray directory
  // declaration), then close the semantic aliases that could otherwise put
  // the same Wrangler source paths back into the realized config.
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source) as unknown;
  } catch {
    // Owning callers retain their existing invalid-TOML error boundary. This
    // helper is responsible only for refusing source-path declarations.
    return;
  }
  if (
    record(parsed) &&
    (Object.hasOwn(parsed, "main") ||
      (record(parsed.assets) && Object.hasOwn(parsed.assets, "directory")))
  ) {
    throw new Error("platform_worker_release_config_declares_source_path");
  }
}

/**
 * Resolve the one source authority shared by platform plan and runner release.
 * Callers provide the already-observed checkout identity; this module owns the
 * config/pin policy, exact repository+commit comparison, and derived paths.
 */
export function resolvePlatformReleaseSourceAuthority(input: Readonly<{
  configPath: string;
  configSource: string;
  repositoryRoot: string;
  checkoutRepository: string;
  checkoutCommit: string;
}>): PlatformReleaseSourceAuthority {
  assertPlatformReleaseConfigPathless(input.configSource);
  if (
    !isAbsolute(input.configPath) ||
    !isAbsolute(input.repositoryRoot) ||
    resolve(input.repositoryRoot) !== input.repositoryRoot
  ) {
    throw new Error("platform_worker_release_source_pin_invalid");
  }
  const pinPath = platformReleaseSourcePinPath(input.configPath);
  const pin = readPlatformReleaseSourcePin(input.configPath);
  assertPlatformReleaseSourcePinMatchesCheckout(pin, {
    repository: input.checkoutRepository,
    commit: input.checkoutCommit,
  });
  return {
    pinPath,
    pin,
    repositoryRoot: input.repositoryRoot,
    entryWorkerPath: resolve(
      input.repositoryRoot,
      "deploy/platform/entry-worker.ts",
    ),
    dashboardAssetsPath: resolve(input.repositoryRoot, "dashboard/dist"),
  };
}

export function assertPlatformReleaseSourcePinMatchesCheckout(
  pin: PlatformReleaseSourcePin,
  checkout: Readonly<{ repository: string; commit: string }>,
): void {
  if (
    !sameGitRemote(checkout.repository, pin.repository) ||
    checkout.commit !== pin.commit
  ) {
    throw new Error(
      `platform_worker_release_source_pin_mismatch: this checkout is ${checkout.repository} at ${checkout.commit}, ` +
        `the realized config pins ${pin.repository} at ${pin.commit}. ` +
        `Materialize it with: bun run deploy -- <surface> materialize-source ` +
        `--config <config> --into <empty directory>`,
    );
  }
}

/** Inject the derived paths into an ephemeral Wrangler-only projection. */
export function injectPlatformSourcePaths(
  source: string,
  entry: string,
  assets: string,
): string {
  try {
    assertPlatformReleaseConfigPathless(source);
  } catch {
    // A projection seeing source paths means the realized bytes changed after
    // their authority check; keep the existing sealed-config failure boundary.
    throw new Error("platform_worker_release_sealed_config_invalid");
  }
  const nameLine = /^name\s*=\s*"[^"]+"\s*$/mu.exec(source);
  const assetsHeading = /^\[assets\]\s*$/mu.exec(source);
  if (!nameLine || !assetsHeading || entry.length === 0 || assets.length === 0) {
    throw new Error("platform_worker_release_sealed_config_invalid");
  }
  const withAssets = `${source.slice(
    0,
    assetsHeading.index! + assetsHeading[0].length,
  )}\ndirectory = ${JSON.stringify(assets.replaceAll("\\", "/"))}${source.slice(
    assetsHeading.index! + assetsHeading[0].length,
  )}`;
  const name = /^name\s*=\s*"[^"]+"\s*$/mu.exec(withAssets)!;
  return `${withAssets.slice(
    0,
    name.index! + name[0].length,
  )}\nmain = ${JSON.stringify(entry.replaceAll("\\", "/"))}${withAssets.slice(
    name.index! + name[0].length,
  )}`;
}

function readStablePhysicalFile(path: string, errorCode: string): Uint8Array {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1n ||
      realpathSync(path) !== path
    ) {
      throw new Error(errorCode);
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!samePhysicalFile(before, openedBefore)) {
      throw new Error(errorCode);
    }
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    if (
      BigInt(bytes.byteLength) !== openedBefore.size ||
      !samePhysicalFile(openedBefore, openedAfter) ||
      !samePhysicalFile(openedAfter, after) ||
      realpathSync(path) !== path
    ) {
      throw new Error(errorCode);
    }
    return bytes;
  } catch {
    throw new Error(errorCode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function samePhysicalFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
