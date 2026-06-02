/**
 * Prepared source reader for runtime-agent connectors.
 *
 * Source-backed connectors read files from an already-prepared source snapshot
 * instead of fetching artifact payloads by hash. Co-located agents can receive
 * a `workingDirectory`; remote agents can receive `url` + `digest` for a tar
 * snapshot that is verified and extracted per apply request.
 *
 * The remote (`url` + `digest`) path mirrors the installer's prepared-source
 * fetcher hardening (`packages/installer/src/prepared-source.ts`): the apply
 * route materializes operator/tenant-influenced locators, and the digest pin
 * alone does NOT mitigate SSRF (the request still reaches the host and the
 * body is buffered before the digest is computed) nor a gzip bomb. The wire is
 * therefore restricted to https://, an SSRF literal-IP blocklist runs before
 * fetch, redirects are rejected, the download is size-capped while streaming,
 * the decompressed size is bounded, and extraction uses the same anti-tar-slip
 * flags and link-target parsing. The blocklist logic is intentionally inlined
 * (rather than imported from the installer) because per the ecosystem layering
 * runtime-agent must not depend on the installer; the clean long-term fix is to
 * promote the blocklist into `takosumi-contract` and import it from both, which
 * is a coordinated cross-package + JSR-version change beyond this file's scope.
 */

import type { PreparedSourceLocator } from "takosumi-contract/reference/runtime-agent-lifecycle";
import type { TarRunner } from "takosumi-contract/reference/runtime-capability";
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
 * via `TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES`. 50 MiB matches the installer twin
 * and the public Installer API source size limit guidance.
 */
const DEFAULT_PREPARED_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Default cap on the DECOMPRESSED size of a prepared-source archive. The wire
 * cap above only bounds the compressed download; without this a small gzip
 * could inflate to many GiB during extraction (gzip bomb). Operators may
 * override via `TAKOSUMI_PREPARED_DECOMPRESSED_MAX_BYTES`. Defaults to 10x the
 * wire cap so legitimate well-compressed sources are not rejected. Matches the
 * installer twin's defaults so behavior stays in parity.
 */
const DEFAULT_PREPARED_DECOMPRESSED_MAX_BYTES = 10 *
  DEFAULT_PREPARED_ARCHIVE_MAX_BYTES;

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
    const compressed = bytes.length >= 2
      ? isGzipBytes(bytes)
      : isGzipUrlSuffix(locator.url);
    await assertSafeTarEntries(bytes, compressed, tarRunner);
    // Extraction safety:
    // - `--no-same-owner` ignores tar uid/gid so a malicious archive cannot
    //   chown extracted files to a privileged user.
    // - `--keep-old-files` makes any second entry that targets the same path
    //   fail closed instead of overwriting earlier extracted files, which
    //   together with the symlink-target check blunts the classic "symlink to
    //   /etc/foo, then write to /etc/foo" tar-slip variant.
    const extractionFlags = [
      "--no-same-owner",
      "--keep-old-files",
    ];
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
        throw new Error(`${label} exceeds ${cap} bytes`);
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

function isAllowedHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * SSRF guard, symmetric with the installer's prepared-source fetcher: reject
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

function assertHostNotBlocked(host: string, label: string): void {
  const literal = stripIpv6Brackets(host);
  if (isIpv4Literal(literal)) {
    if (isBlockedIpv4(literal)) {
      throw new Error(`${label} is not allowed: ${host}`);
    }
    return;
  }
  const groups = parseIpv6(literal);
  if (groups !== null) {
    if (isBlockedIpv6(groups)) {
      throw new Error(`${label} is not allowed: ${host}`);
    }
    return;
  }
  // Not an IP literal: a DNS hostname. Operators control egress.
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

function isIpv4Literal(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split(".").map((segment) => Number.parseInt(segment, 10));
  if (
    parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    // Malformed literal — treat as blocked to fail closed.
    return true;
  }
  const [a, b, c, d] = parts;
  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // RFC1918 private 10/8, 172.16/12, 192.168/16
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16 (covers AWS/GCP metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // Multicast / reserved high ranges
  if (a >= 224) return true;
  // Carrier-grade NAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // Broadcast
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
}

/**
 * Parse an IPv6 literal into its 8 16-bit groups, expanding `::` and folding
 * any trailing embedded IPv4 (`::ffff:1.2.3.4`). Returns null when `value` is
 * not a syntactically valid IPv6 literal (the caller then treats it as a DNS
 * hostname).
 */
function parseIpv6(value: string): readonly number[] | null {
  if (!value.includes(":")) return null;
  // Strip an optional zone id (`fe80::1%eth0`); it never affects classification.
  const zoneSplit = value.indexOf("%");
  let addr = zoneSplit === -1 ? value : value.slice(0, zoneSplit);

  // A literal may end with an embedded IPv4 dotted quad in its last 32 bits
  // (`::ffff:1.2.3.4`). Rewrite that quad into two hex groups so the rest of
  // the parse only deals with colon-separated hex groups.
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIpv4Literal(tail)) return null;
    const octets = tail.split(".").map((o) => Number.parseInt(o, 10));
    if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]) & 0xffff;
    const low = ((octets[2] << 8) | octets[3]) & 0xffff;
    addr = `${addr.slice(0, lastColon + 1)}${high.toString(16)}:${
      low.toString(16)
    }`;
  }

  const doubleColon = addr.indexOf("::");
  let leftPart: string;
  let rightPart: string;
  let hasDoubleColon = false;
  if (doubleColon !== -1) {
    if (addr.indexOf("::", doubleColon + 1) !== -1) return null; // only one `::`
    hasDoubleColon = true;
    leftPart = addr.slice(0, doubleColon);
    rightPart = addr.slice(doubleColon + 2);
  } else {
    leftPart = addr;
    rightPart = "";
  }

  const parseGroups = (part: string): number[] | null => {
    if (part.length === 0) return [];
    const out: number[] = [];
    for (const token of part.split(":")) {
      if (token.length === 0 || token.length > 4) return null;
      if (!/^[0-9a-f]+$/i.test(token)) return null;
      out.push(Number.parseInt(token, 16) & 0xffff);
    }
    return out;
  };

  const left = parseGroups(leftPart);
  const right = parseGroups(rightPart);
  if (left === null || right === null) return null;

  let groups: number[];
  if (hasDoubleColon) {
    const fill = 8 - (left.length + right.length);
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = [...left, ...right];
  }
  if (groups.length !== 8) return null;
  return groups;
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0, g1, , , , g5, g6, g7] = groups;
  // Unspecified ::
  if (groups.every((g) => g === 0)) return true;
  // Loopback ::1
  if (
    g0 === 0 && g1 === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0 && g6 === 0 && g7 === 1
  ) {
    return true;
  }
  // fc00::/7 unique local (fc.. or fd..)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  // IPv4-mapped ::ffff:a.b.c.d (g0..g4 == 0, g5 == 0xffff): re-check IPv4.
  if (
    g0 === 0 && g1 === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0xffff
  ) {
    if (isBlockedIpv4(groupsToDotted(g6, g7))) return true;
  }
  // Deprecated IPv4-compatible ::a.b.c.d (top 96 bits zero). ::/96 is IANA
  // reserved, so rejecting the whole range on a blocked low quad is safe.
  if (
    g0 === 0 && g1 === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0 && !(g6 === 0 && g7 <= 1)
  ) {
    if (isBlockedIpv4(groupsToDotted(g6, g7))) return true;
  }
  // NAT64 well-known prefix 64:ff9b::/96 wrapping an IPv4 — classify the
  // embedded address (e.g. 64:ff9b::169.254.169.254 -> metadata).
  if (
    g0 === 0x64 && g1 === 0xff9b && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && g5 === 0
  ) {
    if (isBlockedIpv4(groupsToDotted(g6, g7))) return true;
  }
  // 6to4 2002:V4ADDR::/48 embeds an IPv4 in the next 32 bits after 2002.
  if (g0 === 0x2002) {
    if (isBlockedIpv4(groupsToDotted(g1, groups[2]))) return true;
  }
  return false;
}

function groupsToDotted(high: number, low: number): string {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${
    low & 0xff
  }`;
}

function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isGzipUrlSuffix(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

async function assertSafeTarEntries(
  bytes: Uint8Array,
  compressed: boolean,
  tarRunner: TarRunner,
): Promise<void> {
  // Single verbose listing pass — we derive both the path table (for the
  // duplicate / traversal check), the per-entry decompressed-size sum, and the
  // link-target check from one tar invocation. `-tv` produces lines like:
  //   -rw-r--r-- user/group  size date time path
  //   lrwxrwxrwx user/group  size date time path -> target
  //   hrw-r--r-- user/group  size date time path link to target
  const verbose = await tarRunner.run(
    compressed ? ["-t", "-v", "-z", "-f", "-"] : ["-t", "-v", "-f", "-"],
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
    // sum the per-entry sizes the `-tv` listing already reports and stop if the
    // inflated total would exceed the decompressed cap before extraction.
    decompressedTotal += parsed.size;
    if (decompressedTotal > decompressedCap) {
      throw new Error(
        `preparedSource archive decompresses to more than ${decompressedCap} bytes`,
      );
    }
    const normalized = normalizeTarEntryPath(
      parsed.path,
      "preparedSource tar entry",
    );
    if (seen.has(normalized)) {
      throw new Error(
        `preparedSource tar entry duplicates normalized path: ${parsed.path}`,
      );
    }
    seen.add(normalized);
    assertSafeTarLinkTarget(parsed, "preparedSource tar entry");
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
 * traversal check and the link-target safety check, so both agree on where the
 * path ends and the link target begins.
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
  // tar reports size in column index 2 (mode owner size ...). For device nodes
  // it is "major,minor"; Number.parseInt yields the major number, which is
  // fine for a coarse decompressed-size guard.
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
    // Regular file / directory: the entire remainder is the path. A filename
    // that contains ` -> ` as literal text is left intact.
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
