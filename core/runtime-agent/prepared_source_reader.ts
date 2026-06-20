/**
 * Prepared source reader for runtime-agent handlers.
 *
 * Source-backed handlers read files from an already-prepared source snapshot
 * instead of fetching artifact payloads by hash. Co-located agents can receive
 * a `workingDirectory`; remote agents can receive `url` + `digest` for a tar
 * snapshot that is verified and extracted per apply request.
 *
 * The remote (`url` + `digest`) path mirrors the deploy control prepared-source
 * fetcher hardening in `takosumi-contract/reference/*`: the apply
 * route materializes operator/tenant-influenced locators, and the digest pin
 * alone does NOT mitigate SSRF (the request still reaches the host and the
 * body is buffered before the digest is computed) nor a gzip bomb. The wire is
 * therefore restricted to https://, an SSRF literal-IP blocklist runs before
 * fetch, redirects are rejected, the download is size-capped while streaming,
 * the decompressed size is bounded, and extraction uses the same anti-tar-slip
 * flags and link-target parsing. The blocklist and tar-safety / capped-fetch
 * core are imported from `takosumi-contract/reference/*` — the layer that both
 * the deployControl and runtime-agent already depend on — so the single SSRF /
 * tar-verify implementation cannot drift between the two call sites and
 * silently weaken one of them (runtime-agent still does not depend on the
 * deployControl: the shared core lives below both in the contract layer).
 */

import type { PreparedSourceLocator } from "takosumi-contract/reference/runtime-agent-lifecycle";
import type { TarRunner } from "takosumi-contract/reference/runtime-capability";
import { assertHostNotBlocked } from "takosumi-contract/reference/host-blocklist";
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
import { defaultTarRunner } from "./capability_runners.ts";
import {
  makeRuntimeTempDir,
  readRuntimeEnv,
  readRuntimeFile,
  removeRuntimePath,
} from "./runtime.ts";

export interface PreparedSourceReader {
  readFile(path: string): Promise<Uint8Array>;
}

export interface PreparedSourceContext {
  readonly reader: PreparedSourceReader;
  readonly cleanup: () => Promise<void>;
}

/**
 * Default cap on the prepared-source archive wire size. Operators may override
 * via `TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES`. 50 MiB matches the deploy control twin
 * and the public Deploy Control API source size limit guidance.
 */
const DEFAULT_PREPARED_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Default cap on the DECOMPRESSED size of a prepared-source archive. The wire
 * cap above only bounds the compressed download; without this a small gzip
 * could inflate to many GiB during extraction (gzip bomb). Operators may
 * override via `TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES`. Defaults to 10x the
 * wire cap so legitimate well-compressed sources are not rejected. Matches the
 * deploy control twin's defaults so behavior stays in parity.
 */
const DEFAULT_PREPARED_DECOMPRESSED_MAX_BYTES =
  10 * DEFAULT_PREPARED_ARCHIVE_MAX_BYTES;

function preparedArchiveMaxBytes(): number {
  return readPositiveByteEnv(
    "TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES",
    DEFAULT_PREPARED_ARCHIVE_MAX_BYTES,
  );
}

function preparedDecompressedMaxBytes(): number {
  return readPositiveByteEnv(
    "TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES",
    DEFAULT_PREPARED_DECOMPRESSED_MAX_BYTES,
  );
}

function readPositiveByteEnv(name: string, fallback: number): number {
  const raw = readRuntimeEnv(name);
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export async function sourceContextFromLocator(
  locator: PreparedSourceLocator | undefined,
  // `tar` is an injected runtime capability rather than a direct subprocess
  // call in the library surface; defaults to the runtime-agent's local
  // subprocess-backed runner so existing runtime behavior is unchanged.
  tarRunner: TarRunner = defaultTarRunner,
): Promise<PreparedSourceContext | undefined> {
  if (!locator) return undefined;
  if (locator.workingDirectory) {
    // Co-located service/agent setups: the source tree is already on disk and
    // trusted, so no fetch / SSRF / extraction step runs. Left unchanged.
    return {
      reader: new LocalPreparedSourceReader(locator.workingDirectory),
      cleanup: () => Promise.resolve(),
    };
  }
  if (!locator.url || !locator.digest) {
    throw new Error(
      "preparedSource requires workingDirectory or both url and digest",
    );
  }
  // The remote form is fetched over the network on the operator's behalf, so
  // it must be https:// (no http:// / file:// / raw-path egress) and survive
  // the SSRF literal-IP guard before any fetch runs.
  if (!isAllowedHttpsUrl(locator.url)) {
    throw new Error(
      `preparedSource url must use https:// (got ${locator.url})`,
    );
  }
  assertPreparedHostNotBlocked(locator.url);
  if (!isSha256Digest(locator.digest)) {
    throw new Error("preparedSource digest must use sha256:<64 lowercase hex>");
  }
  const bytes = await readArchive(locator.url);
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== locator.digest) {
    throw new Error(
      `preparedSource digest mismatch: expected ${locator.digest}, got ${actualDigest}`,
    );
  }
  const destination = await makeRuntimeTempDir(
    "takosumi-runtime-agent-source-",
  );
  try {
    // The gzip magic bytes are authoritative; the URL suffix is consulted only
    // when the body is too short to carry the 2-byte magic so a misleading
    // `.tgz` URL cannot override a body the byte check identified as not gzip.
    const compressed =
      bytes.length >= 2 ? isGzipBytes(bytes) : isGzipUrlSuffix(locator.url);
    await assertSafeTarEntries(
      tarRunner,
      bytes,
      compressed,
      preparedDecompressedMaxBytes(),
      {
        unparseableLine: (line) =>
          `preparedSource tar listing has an unparseable entry line: ${line}`,
        decompressedTooLarge: (cap) =>
          `preparedSource archive decompresses to more than ${cap} bytes`,
        duplicatePath: (path) =>
          `preparedSource tar entry duplicates normalized path: ${path}`,
        entryLabel: "preparedSource tar entry",
      },
    );
    // Extraction safety:
    // - `--no-same-owner` ignores tar uid/gid so a malicious archive cannot
    //   chown extracted files to a privileged user.
    // - `--keep-old-files` makes any second entry that targets the same path
    //   fail closed instead of overwriting earlier extracted files, which
    //   together with the symlink-target check blunts the classic "symlink to
    //   /etc/foo, then write to /etc/foo" tar-slip variant.
    const extractionFlags = PREPARED_SOURCE_EXTRACTION_FLAGS;
    await tarRunner.run(
      compressed
        ? ["-x", "-z", "-f", "-", ...extractionFlags, "-C", destination]
        : ["-x", "-f", "-", ...extractionFlags, "-C", destination],
      bytes,
    );
  } catch (err) {
    await removeRuntimePath(destination, { recursive: true }).catch(() => {});
    throw err;
  }
  return {
    reader: new LocalPreparedSourceReader(destination),
    cleanup: () => removeRuntimePath(destination, { recursive: true }),
  };
}

export class LocalPreparedSourceReader implements PreparedSourceReader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root.replace(/\/+$/, "");
  }

  readFile(path: string): Promise<Uint8Array> {
    return readRuntimeFile(`${this.#root}/${normalizeRelativePath(path)}`);
  }
}

function normalizeRelativePath(path: string): string {
  if (path.length === 0 || path.startsWith("/")) {
    throw new Error("prepared source path must be relative");
  }
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      throw new Error("prepared source path must not escape source root");
    }
    out.push(segment);
  }
  if (out.length === 0) throw new Error("prepared source path is empty");
  return out.join("/");
}

async function readArchive(url: string): Promise<Uint8Array> {
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
      `preparedSource url must not redirect (got ${response.status} from ${url})`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `failed to fetch preparedSource ${url}: ${response.status} ${response.statusText}`,
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
        `preparedSource archive declares ${declared} bytes, cap is ${cap}`,
      );
    }
  }
  return await readBodyWithCap(response, cap, "preparedSource archive");
}

/**
 * SSRF guard, symmetric with the deploy control prepared-source fetcher: reject
 * loopback / RFC1918 / link-local / cloud-metadata IP literals before reaching
 * out. The digest pin does NOT mitigate SSRF — the request itself reaches the
 * internal host, and the caller supplies the matching digest in the same
 * request. Hostnames are deliberately NOT resolved here; operators constrain
 * the agent's network egress to trusted destinations.
 */
function assertPreparedHostNotBlocked(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`preparedSource url is not a valid URL: ${url}`);
  }
  assertHostNotBlocked(host, "preparedSource host");
}
