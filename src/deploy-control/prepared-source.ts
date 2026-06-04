/**
 * Prepared source fetcher for operator-owned build/preparation services.
 *
 * A prepared source is an immutable tar snapshot of the source tree after any
 * external build/preparation step has run. The service verifies the archive
 * digest before deriving the install plan.
 */

import type {
  DeployControlFs,
  TarRunner,
} from "takosumi-contract/reference/runtime-capability";
import {
  assertSafeTarEntries,
  isAllowedHttpsUrl,
  isGzipBytes,
  isGzipUrlSuffix,
  isRedirectStatus,
  isSha256Digest,
  PREPARED_SOURCE_EXTRACTION_FLAGS,
  readBodyWithCap,
  sha256Hex,
} from "takosumi-contract/reference/prepared-source-core";
import { assertHostNotBlocked, BlockedHostError } from "./host-blocklist.ts";
import { defaultDeployControlFs } from "./default-fs.ts";
import { defaultTarRunner } from "./subprocess/tar-runner.ts";

export interface PreparedSourceFetchOptions {
  readonly url: string;
  readonly digest: string;
  readonly destination?: string;
  /**
   * Injected `tar` capability. Defaults to a runner built over the deploy control
   * local `tar` primitive so standalone behavior is unchanged; the reference
   * service injects a runner routed through `currentRuntime().subprocess` so the
   * same path runs on Bun / Node / Workers.
   */
  readonly tarRunner?: TarRunner;
  /**
   * Injected temp-dir filesystem capability. Defaults to a host-detected FS;
   * the reference service injects `currentRuntime().fs`.
   */
  readonly fs?: DeployControlFs;
}

export interface PreparedSourceFetchResult {
  readonly workingDirectory: string;
  readonly digest: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Closed-envelope error code for prepared source URLs the deployControl
 * refuses to fetch. Callers translate this to a 409 failed_precondition
 * in the public Deploy Control API surface.
 */
const UNSUPPORTED_SOURCE_URL = "unsupported_source_url";

/**
 * Closed-envelope error code for archives that exceed the configured
 * size cap. Callers translate this to a 413 resource_exhausted in the
 * public Deploy Control API surface.
 */
const ARCHIVE_TOO_LARGE = "archive_too_large";

/**
 * Default cap on prepared-source archive size. Operators may override
 * via `TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES`. 50 MiB matches the public
 * Deploy Control API source size limit guidance.
 */
const DEFAULT_PREPARED_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

function preparedArchiveMaxBytes(): number {
  return readPositiveByteEnv(
    "TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES",
    DEFAULT_PREPARED_ARCHIVE_MAX_BYTES,
  );
}

/**
 * Default cap on the DECOMPRESSED size of a prepared-source archive. The wire
 * cap above only bounds the compressed download; without this a small gzip
 * could inflate to many GiB during extraction (gzip bomb), exhausting the
 * operator's disk / inodes. Operators may override via
 * `TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES`. Defaults to 10x the wire cap so
 * legitimate well-compressed sources are not rejected.
 */
const DEFAULT_PREPARED_DECOMPRESSED_MAX_BYTES = 10 *
  DEFAULT_PREPARED_ARCHIVE_MAX_BYTES;

function preparedDecompressedMaxBytes(): number {
  return readPositiveByteEnv(
    "TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES",
    DEFAULT_PREPARED_DECOMPRESSED_MAX_BYTES,
  );
}

function readPositiveByteEnv(name: string, fallback: number): number {
  const processEnv = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const raw = processEnv?.[name];
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export async function fetchPreparedSource(
  options: PreparedSourceFetchOptions,
): Promise<PreparedSourceFetchResult> {
  if (options.url.length === 0) {
    throw new Error("prepared source requires a non-empty url");
  }
  if (!isAllowedHttpsUrl(options.url)) {
    throw new Error(
      `${UNSUPPORTED_SOURCE_URL}: prepared source url must use https:// (got ${options.url})`,
    );
  }
  // SSRF guard, symmetric with git-fetch: reject loopback / private /
  // link-local / cloud-metadata IP literals before reaching out. The digest
  // pin does NOT mitigate SSRF — the request itself reaches the internal
  // host, and the caller supplies the matching digest in the same request.
  assertPreparedHostNotBlocked(options.url);
  if (!isSha256Digest(options.digest)) {
    throw new Error("prepared source digest must use sha256:<hex>");
  }

  const tarRunner = options.tarRunner ?? defaultTarRunner;
  const fs = options.fs ?? defaultDeployControlFs;

  const bytes = await readPreparedArchive(options.url);
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== options.digest) {
    throw new Error(
      `prepared source digest mismatch: expected ${options.digest}, got ${actualDigest}`,
    );
  }

  const destination = options.destination ??
    (await fs.makeTempDir("takosumi-prepared-source-"));
  const ownsDestination = options.destination === undefined;
  try {
    // The gzip magic bytes are authoritative; the URL suffix is consulted
    // only when the body is too short to carry the 2-byte magic (e.g. an
    // empty/zero-byte head) so a misleading `.tgz` URL cannot override a body
    // that the byte check positively identified as not gzip.
    const compressed = bytes.length >= 2
      ? isGzipBytes(bytes)
      : isGzipUrlSuffix(options.url);
    await assertSafeTarEntries(
      tarRunner,
      bytes,
      compressed,
      preparedDecompressedMaxBytes(),
      {
        unparseableLine: (line) =>
          `preparedSource tar listing has an unparseable entry line: ${line}`,
        decompressedTooLarge: (cap) =>
          `${ARCHIVE_TOO_LARGE}: prepared source archive decompresses to more than ${cap} bytes`,
        duplicatePath: (path) =>
          `prepared source tar entry duplicates normalized path: ${path}`,
        entryLabel: "prepared source tar entry",
      },
    );
    // Extraction safety:
    // - `--no-same-owner` ignores tar uid/gid so a malicious archive cannot
    //   chown extracted files to a privileged user.
    // - `--keep-old-files` makes any second entry that targets the same
    //   path fail closed instead of overwriting earlier extracted files,
    //   which together with the symlink-target check blunts the classic
    //   "symlink to /etc/foo, then write to /etc/foo" tar-slip variant.
    //   (GNU tar treats `--keep-old-files` and `--no-overwrite-dir` as
    //   mutually exclusive, so we keep the stronger overwrite refusal and
    //   rely on the symlink target check for directory-overlay safety.)
    const extractionFlags = PREPARED_SOURCE_EXTRACTION_FLAGS;
    await runTar(
      tarRunner,
      compressed
        ? ["-x", "-z", "-f", "-", ...extractionFlags, "-C", destination]
        : ["-x", "-f", "-", ...extractionFlags, "-C", destination],
      bytes,
    );
  } catch (err) {
    if (ownsDestination) {
      await fs.remove(destination, { recursive: true }).catch(() => {});
    }
    throw err;
  }

  return {
    workingDirectory: destination,
    digest: actualDigest,
    cleanup: () => fs.remove(destination, { recursive: true }),
  };
}

async function readPreparedArchive(url: string): Promise<Uint8Array> {
  // `redirect: "manual"` closes the SSRF-via-redirect bypass: a host that
  // passes the blocklist could otherwise 3xx-redirect to an internal target
  // that the initial-URL check never sees. We reject any redirect outright
  // rather than re-validating each hop.
  const response = await fetch(url, { redirect: "manual" });
  if (response.type === "opaqueredirect" || isRedirectStatus(response.status)) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }
    throw new Error(
      `${UNSUPPORTED_SOURCE_URL}: prepared source url must not redirect (got ${response.status} from ${url})`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `failed to fetch prepared source ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const cap = preparedArchiveMaxBytes();
  // Trust `Content-Length` to short-circuit oversized downloads before we
  // buffer the body. A missing, lying, or chunked (header-absent) response
  // still cannot exceed the cap because the streaming read below aborts once
  // the running byte count crosses it.
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > cap) {
      try {
        await response.body?.cancel();
      } catch {
        // The body may already be locked / consumed; ignore.
      }
      throw new Error(
        `${ARCHIVE_TOO_LARGE}: prepared source archive declares ${declared} bytes, cap is ${cap}`,
      );
    }
  }
  return await readBodyWithCap(
    response,
    cap,
    "prepared source archive",
    (label, capBytes) => `${ARCHIVE_TOO_LARGE}: ${label} exceeds ${capBytes} bytes`,
  );
}

function assertPreparedHostNotBlocked(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(
      `${UNSUPPORTED_SOURCE_URL}: prepared source url is not a valid URL: ${url}`,
    );
  }
  try {
    assertHostNotBlocked(host, "prepared source host");
  } catch (err) {
    if (err instanceof BlockedHostError) {
      throw new Error(`${UNSUPPORTED_SOURCE_URL}: ${err.message}`);
    }
    throw err;
  }
}

function runTar(
  tarRunner: TarRunner,
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  return tarRunner.run(args, stdin);
}
