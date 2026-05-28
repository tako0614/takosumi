/**
 * Prepared source fetcher for operator-owned build/preparation services.
 *
 * A prepared source is an immutable tar snapshot of the source tree after any
 * external build/preparation step has run. The kernel verifies the archive
 * digest before reading `.takosumi.yml` and invoking materializers.
 */

export interface PreparedSourceFetchOptions {
  readonly url: string;
  readonly digest: string;
  readonly destination?: string;
}

export interface PreparedSourceFetchResult {
  readonly workingDirectory: string;
  readonly digest: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Closed-envelope error code for prepared source URLs the installer
 * refuses to fetch. Callers translate this to a 409 failed_precondition
 * in the public Installer API surface.
 */
const UNSUPPORTED_SOURCE_URL = "unsupported_source_url";

/**
 * Closed-envelope error code for archives that exceed the configured
 * size cap. Callers translate this to a 413 resource_exhausted in the
 * public Installer API surface.
 */
const ARCHIVE_TOO_LARGE = "archive_too_large";

/**
 * Default cap on prepared-source archive size. Operators may override
 * via `TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES`. 50 MiB matches the public
 * Installer API source size limit guidance.
 */
const DEFAULT_PREPARED_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

function preparedArchiveMaxBytes(): number {
  const raw = Deno.env.get("TAKOSUMI_PREPARED_ARCHIVE_MAX_BYTES");
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_PREPARED_ARCHIVE_MAX_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PREPARED_ARCHIVE_MAX_BYTES;
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
  if (!isSha256Digest(options.digest)) {
    throw new Error("prepared source digest must use sha256:<hex>");
  }

  const bytes = await readPreparedArchive(options.url);
  const actualDigest = await sha256Hex(bytes);
  if (actualDigest !== options.digest) {
    throw new Error(
      `prepared source digest mismatch: expected ${options.digest}, got ${actualDigest}`,
    );
  }

  const destination = options.destination ??
    (await Deno.makeTempDir({ prefix: "takosumi-prepared-source-" }));
  const ownsDestination = options.destination === undefined;
  try {
    const compressed = isGzipBytes(bytes) || isGzipUrlSuffix(options.url);
    await assertSafeTarEntries(bytes, compressed);
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
      compressed
        ? ["-x", "-z", "-f", "-", ...extractionFlags, "-C", destination]
        : ["-x", "-f", "-", ...extractionFlags, "-C", destination],
      bytes,
    );
  } catch (err) {
    if (ownsDestination) {
      await Deno.remove(destination, { recursive: true }).catch(() => {});
    }
    throw err;
  }

  return {
    workingDirectory: destination,
    digest: actualDigest,
    cleanup: () => Deno.remove(destination, { recursive: true }),
  };
}

async function readPreparedArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `failed to fetch prepared source ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const cap = preparedArchiveMaxBytes();
  // Trust `Content-Length` to short-circuit oversized downloads before we
  // buffer the body. A missing or non-numeric header just falls through to
  // the post-read length check below.
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
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > cap) {
    throw new Error(
      `${ARCHIVE_TOO_LARGE}: prepared source archive is ${bytes.byteLength} bytes, cap is ${cap}`,
    );
  }
  return bytes;
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
 * Fallback URL-suffix sniff used only if the byte check is inconclusive
 * (e.g. zero-byte head). Kept for parity with documentation conventions.
 */
function isGzipUrlSuffix(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
}

async function assertSafeTarEntries(
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
    compressed ? ["-t", "-v", "-z", "-f", "-"] : ["-t", "-v", "-f", "-"],
    bytes,
  );
  const seen = new Set<string>();
  for (const line of verbose.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const entryPath = extractTarEntryPath(line);
    if (entryPath === null) continue;
    const normalized = normalizeTarEntryPath(
      entryPath,
      "prepared source tar entry",
    );
    if (seen.has(normalized)) {
      throw new Error(
        `prepared source tar entry duplicates normalized path: ${entryPath}`,
      );
    }
    seen.add(normalized);
    assertSafeTarLinkTarget(line, "prepared source tar entry");
  }
}

/**
 * Extract the entry path from a `tar -tv` line. We strip the file mode,
 * owner, size, and date columns and only treat ` -> ` / ` link to ` as a
 * separator when the entry type is a symlink (`l`) or hardlink (`h`). For
 * regular files (`-`) and directories (`d`), the filename is used verbatim
 * so a regular file literally named `evil -> target` cannot smuggle a
 * separator that breaks duplicate / traversal detection.
 */
function extractTarEntryPath(line: string): string | null {
  // tar -tv uses whitespace-separated columns: mode owner size date time path
  // We split on runs of whitespace up to 5 times to keep paths with spaces intact.
  const columns = line.split(/\s+/);
  if (columns.length < 6) return null;
  // Reconstruct the remainder after the 5 metadata columns.
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
    return remainder;
  }
  const arrowIndex = remainder.indexOf(" -> ");
  const linkToIndex = remainder.indexOf(" link to ");
  const cutPoints = [arrowIndex, linkToIndex].filter((idx) => idx >= 0);
  if (cutPoints.length === 0) return remainder;
  return remainder.slice(0, Math.min(...cutPoints));
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

function assertSafeTarLinkTarget(line: string, label: string): void {
  const type = line[0];
  if (type !== "l" && type !== "h") return;
  const target = type === "l"
    ? line.split(" -> ")[1]
    : line.split(" link to ")[1];
  if (!target) return;
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

async function runTar(
  args: readonly string[],
  stdin: Uint8Array,
): Promise<string> {
  // Force a deterministic C locale so the `tar -tv` column format (mode,
  // owner, size, date, time, path) does not shift with the operator's
  // LANG / LC_TIME settings. Without this, locale-specific date / time
  // columns can introduce extra whitespace runs that confuse the column
  // parser.
  const child = new Deno.Command("tar", {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env: {
      LC_ALL: "C",
      LANG: "C",
    },
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(stdin);
  await writer.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`tar ${args.join(" ")} failed: ${decode(stderr)}`);
  }
  return decode(stdout);
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

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
