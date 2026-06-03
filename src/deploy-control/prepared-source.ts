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
    await assertSafeTarEntries(tarRunner, bytes, compressed);
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
    const extractionFlags = [
      "--no-same-owner",
      "--keep-old-files",
    ];
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
  return await readBodyWithCap(response, cap, "prepared source archive");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

/**
 * Read a response body into memory, aborting as soon as the accumulated byte
 * count exceeds `cap`. This bounds memory even when the server omits / lies
 * about `Content-Length` or uses chunked transfer-encoding, which a plain
 * `arrayBuffer()` would buffer in full before any size check.
 */
async function readBodyWithCap(
  response: Response,
  cap: number,
  label: string,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    return new Uint8Array(0);
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `${ARCHIVE_TOO_LARGE}: ${label} exceeds ${cap} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

function isAllowedHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Detect gzip by content (RFC 1952 magic bytes 0x1f 0x8b). This is the
 * authoritative check because the URL suffix may not reflect actual encoding.
 */
function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Fallback URL-suffix sniff. The caller only consults this when the body is
 * too short to read the gzip magic ({@link isGzipBytes} inconclusive), so the
 * authoritative byte check always wins when bytes are present.
 */
function isGzipUrlSuffix(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
}

async function assertSafeTarEntries(
  tarRunner: TarRunner,
  bytes: Uint8Array,
  compressed: boolean,
): Promise<void> {
  // Single verbose listing pass — we derive both the path table (for the
  // duplicate / traversal check) and the link target check from one tar
  // invocation. `-tv` produces lines like:
  //   -rw-r--r-- user/group  size date time path
  //   lrwxrwxrwx user/group  size date time path -> target
  //   hrw-r--r-- user/group  size date time path link to target
  const verbose = await runTar(
    tarRunner,
    compressed
      ? ["-t", "-v", "--quoting-style=literal", "-z", "-f", "-"]
      : ["-t", "-v", "--quoting-style=literal", "-f", "-"],
    bytes,
  );
  const seen = new Set<string>();
  let decompressedTotal = 0;
  const decompressedCap = preparedDecompressedMaxBytes();
  for (const line of verbose.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const parsed = parseTarVerboseLine(line);
    if (parsed === null) continue;
    // Reject gzip bombs: the wire cap only bounds the compressed download, so
    // sum the per-entry sizes the `-tv` listing already reports and stop if
    // the inflated total would exceed the decompressed cap before extraction.
    decompressedTotal += parsed.size;
    if (decompressedTotal > decompressedCap) {
      throw new Error(
        `${ARCHIVE_TOO_LARGE}: prepared source archive decompresses to more than ${decompressedCap} bytes`,
      );
    }
    const normalized = normalizeTarEntryPath(
      parsed.path,
      "prepared source tar entry",
    );
    if (seen.has(normalized)) {
      throw new Error(
        `prepared source tar entry duplicates normalized path: ${parsed.path}`,
      );
    }
    seen.add(normalized);
    assertSafeTarLinkTarget(parsed, "prepared source tar entry");
  }
}

interface TarVerboseEntry {
  /** First mode char: `-` file, `d` dir, `l` symlink, `h` hardlink. */
  readonly type: string;
  /** Declared entry size in bytes (0 for non-regular entries). */
  readonly size: number;
  /** The entry path with any ` -> ` / ` link to ` link suffix stripped. */
  readonly path: string;
  /**
   * The link target (everything AFTER the first link separator), or null when
   * the entry is not a symlink / hardlink or carries no separator.
   */
  readonly linkTarget: string | null;
}

/**
 * Parse one `tar -tv` line into its type, declared size, path, and link
 * target. This is the single column-aware parse shared by the duplicate /
 * traversal check and the link-target safety check, so both agree on where
 * the path ends and the link target begins.
 *
 * tar -tv columns: `mode owner size date time path[ -> target]`. We strip the
 * 5 leading metadata columns, then for symlink (`l`) / hardlink (`h`) entries
 * cut at the FIRST ` -> ` / ` link to ` separator: the path is everything
 * before it, the link target everything after (including any further ` -> `
 * inside the target). For regular files / directories the entire remainder is
 * the path verbatim, so a file literally named `evil -> target` cannot smuggle
 * a separator that breaks duplicate / traversal detection.
 */
function parseTarVerboseLine(line: string): TarVerboseEntry | null {
  const columns = line.split(/\s+/);
  if (columns.length < 6) return null;
  // tar reports size in column index 2 (mode owner size ...). For device
  // nodes it is "major,minor"; Number.parseInt yields the major number, which
  // is fine for a coarse decompressed-size guard.
  const rawSize = Number.parseInt(columns[2], 10);
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0;
  // Walk past the 5 metadata columns to find the path remainder while keeping
  // paths that contain spaces intact.
  let cursor = 0;
  let column = 0;
  while (column < 5 && cursor < line.length) {
    while (cursor < line.length && /\s/.test(line[cursor])) cursor += 1;
    while (cursor < line.length && !/\s/.test(line[cursor])) cursor += 1;
    column += 1;
  }
  while (cursor < line.length && /\s/.test(line[cursor])) cursor += 1;
  const remainder = line.slice(cursor);
  if (remainder.length === 0) return null;
  const type = line[0];
  if (type !== "l" && type !== "h") {
    // Regular file / directory: the entire remainder is the path. A
    // filename that contains ` -> ` as literal text is left intact.
    return { type, size, path: remainder, linkTarget: null };
  }
  const arrowIndex = remainder.indexOf(" -> ");
  const linkToIndex = remainder.indexOf(" link to ");
  const candidates: Array<{ idx: number; sepLen: number }> = [];
  if (arrowIndex >= 0) candidates.push({ idx: arrowIndex, sepLen: 4 });
  if (linkToIndex >= 0) candidates.push({ idx: linkToIndex, sepLen: 9 });
  if (candidates.length === 0) {
    return { type, size, path: remainder, linkTarget: null };
  }
  // Cut at the FIRST separator so the path matches the regular-file extractor
  // and the link target is the real remainder, not a filename fragment.
  const first = candidates.reduce((a, b) => (b.idx < a.idx ? b : a));
  return {
    type,
    size,
    path: remainder.slice(0, first.idx),
    linkTarget: remainder.slice(first.idx + first.sepLen),
  };
}

function normalizeTarEntryPath(entry: string, label: string): string {
  if (entry.startsWith("/") || entry.includes("\0")) {
    throw new Error(`${label} is unsafe: ${entry}`);
  }
  const withoutTrailingSlash = entry.replace(/\/+$/, "");
  if (
    withoutTrailingSlash.length === 0 ||
    withoutTrailingSlash === "." ||
    withoutTrailingSlash === ".."
  ) {
    throw new Error(`${label} is empty or root-only: ${entry}`);
  }
  const segments = withoutTrailingSlash.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`${label} escapes destination: ${entry}`);
  }
  return segments.join("/");
}

function assertSafeTarLinkTarget(entry: TarVerboseEntry, label: string): void {
  const target = entry.linkTarget;
  // Use the link target the shared parser already cut at the FIRST separator,
  // so a symlink whose own filename contains ` -> ` cannot make us validate a
  // filename fragment instead of the real (escaping) target.
  if (target === null || target.length === 0) return;
  if (target.startsWith("/") || target.includes("\0")) {
    throw new Error(`${label} link target is unsafe: ${target}`);
  }
  if (
    target.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`${label} link target escapes destination: ${target}`);
  }
}

function runTar(
  tarRunner: TarRunner,
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  return tarRunner.run(args, stdin);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}
