/**
 * Canonical tar-safety + capped-fetch core shared by prepared-source fetchers.
 *
 * Both the deploy-control prepared-source fetcher and the runtime-agent
 * prepared-source reader materialize an operator/tenant-influenced tar snapshot
 * over the network and extract it. The digest pin alone does NOT mitigate SSRF
 * (the request still reaches the host and the body is buffered before the digest
 * is computed) nor a gzip bomb, so the same defenses must run on both paths:
 *
 *  - the download is size-capped while streaming ({@link readBodyWithCap}),
 *  - gzip is detected by authoritative magic bytes ({@link isGzipBytes}) with a
 *    URL-suffix fallback only when the body is too short to read the magic,
 *  - the tar listing is taken with `--quoting-style=escape` so a control char in
 *    an entry name can never split the listing across lines, and any unparseable
 *    non-empty line is REJECTED rather than skipped,
 *  - per-entry sizes are summed and rejected past the decompressed cap,
 *  - paths and link targets are normalized and rejected when they escape.
 *
 * This module lives in `contract/reference/*` — the layer that BOTH
 * `src/deploy-control` and `src/runtime-agent` already import — so the single
 * tar-verify / capped-fetch core cannot drift between the two extraction sites
 * and silently weaken one of them.
 *
 * Error MESSAGE text differs slightly between the two callers (one prefixes
 * closed-envelope codes for the public Deploy Control API), so the security
 * checks below take a {@link TarSafetyMessages} bag and label strings to build
 * each thrown message; the security LOGIC is identical for both.
 */

import type { TarRunner } from "../runtime-capability.ts";

/** Reusable extraction flags shared by both prepared-source extractors. */
export const PREPARED_SOURCE_EXTRACTION_FLAGS: readonly string[] = [
  "--no-same-owner",
  "--keep-old-files",
];

export function isAllowedHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isSha256Digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

/**
 * Detect gzip by content (RFC 1952 magic bytes 0x1f 0x8b). This is the
 * authoritative check because the URL suffix may not reflect actual encoding.
 */
export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Fallback URL-suffix sniff. The caller only consults this when the body is
 * too short to read the gzip magic ({@link isGzipBytes} inconclusive), so the
 * authoritative byte check always wins when bytes are present.
 */
export function isGzipUrlSuffix(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return `sha256:${
    Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

/**
 * Read a response body into memory, aborting as soon as the accumulated byte
 * count exceeds `cap`. This bounds memory even when the server omits / lies
 * about `Content-Length` or uses chunked transfer-encoding, which a plain
 * `arrayBuffer()` would buffer in full before any size check.
 *
 * `tooLargeMessage` lets callers prefix a closed-envelope error code while the
 * cap-crossing behavior stays identical.
 */
export async function readBodyWithCap(
  response: Response,
  cap: number,
  label: string,
  tooLargeMessage: (label: string, cap: number) => string =
    defaultExceedsCapMessage,
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
        throw new Error(tooLargeMessage(label, cap));
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

function defaultExceedsCapMessage(label: string, cap: number): string {
  return `${label} exceeds ${cap} bytes`;
}

export interface TarVerboseEntry {
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
export function parseTarVerboseLine(line: string): TarVerboseEntry | null {
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

export function normalizeTarEntryPath(entry: string, label: string): string {
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

export function assertSafeTarLinkTarget(
  entry: TarVerboseEntry,
  label: string,
): void {
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

/**
 * Caller-supplied error messages for {@link assertSafeTarEntries}. The two
 * prepared-source fetchers differ only in this text (one prefixes
 * closed-envelope codes for the public Deploy Control API); the per-entry
 * security checks are identical for both.
 */
export interface TarSafetyMessages {
  /** Built when a non-empty listing line fails to parse. */
  readonly unparseableLine: (line: string) => string;
  /** Built when the summed decompressed size crosses `cap`. */
  readonly decompressedTooLarge: (cap: number) => string;
  /** Built when a normalized path is seen twice in the listing. */
  readonly duplicatePath: (path: string) => string;
  /** Label passed to {@link normalizeTarEntryPath} / link-target checks. */
  readonly entryLabel: string;
}

/**
 * Single verbose listing pass — derive the path table (for the duplicate /
 * traversal check), the per-entry decompressed-size sum, and the link-target
 * check from one tar invocation. `-tv` produces lines like:
 *   -rw-r--r-- user/group  size date time path
 *   lrwxrwxrwx user/group  size date time path -> target
 *   hrw-r--r-- user/group  size date time path link to target
 * SECURITY (tar-slip / link-target bypass): use `--quoting-style=escape`, NOT
 * `literal`. Literal quoting lets a newline byte in an entry name split the
 * listing across two lines, so the link-target / traversal / duplicate checks
 * see a harmless first line and silently skip the dangerous fragment while
 * `tar -x` still extracts the real entry. Escape quoting renders control chars
 * as backslash sequences so a name can never span lines, and we REJECT any
 * unparseable non-empty line instead of skipping it.
 */
export async function assertSafeTarEntries(
  tarRunner: TarRunner,
  bytes: Uint8Array,
  compressed: boolean,
  decompressedCap: number,
  messages: TarSafetyMessages,
): Promise<void> {
  const verbose = await tarRunner.run(
    compressed
      ? ["-t", "-v", "--quoting-style=escape", "-z", "-f", "-"]
      : ["-t", "-v", "--quoting-style=escape", "-f", "-"],
    bytes,
  );
  const seen = new Set<string>();
  let decompressedTotal = 0;
  for (const line of verbose.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const parsed = parseTarVerboseLine(line);
    if (parsed === null) {
      throw new Error(messages.unparseableLine(line));
    }
    // Reject gzip bombs: the wire cap only bounds the compressed download, so
    // sum the per-entry sizes the `-tv` listing already reports and stop if
    // the inflated total would exceed the decompressed cap before extraction.
    decompressedTotal += parsed.size;
    if (decompressedTotal > decompressedCap) {
      throw new Error(messages.decompressedTooLarge(decompressedCap));
    }
    const normalized = normalizeTarEntryPath(parsed.path, messages.entryLabel);
    if (seen.has(normalized)) {
      throw new Error(messages.duplicatePath(parsed.path));
    }
    seen.add(normalized);
    assertSafeTarLinkTarget(parsed, messages.entryLabel);
  }
}
