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

export async function fetchPreparedSource(
  options: PreparedSourceFetchOptions,
): Promise<PreparedSourceFetchResult> {
  if (options.url.length === 0) {
    throw new Error("prepared source requires a non-empty url");
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
    const compressed = isGzipArchive(options.url);
    await assertSafeTarEntries(bytes, compressed);
    await runTar(
      compressed ? ["-x", "-z", "-f", "-", "-C", destination] : [
        "-x",
        "-f",
        "-",
        "-C",
        destination,
      ],
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
  if (isHttpUrl(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `failed to fetch prepared source ${url}: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  if (url.startsWith("file://")) {
    return await Deno.readFile(decodeURIComponent(new URL(url).pathname));
  }
  return await Deno.readFile(url);
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function isGzipArchive(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
}

async function assertSafeTarEntries(
  bytes: Uint8Array,
  compressed: boolean,
): Promise<void> {
  const stdout = await runTar(
    compressed ? ["-t", "-z", "-f", "-"] : ["-t", "-f", "-"],
    bytes,
  );
  const seen = new Set<string>();
  for (const entry of stdout.split(/\r?\n/)) {
    if (entry.length === 0) continue;
    const normalized = normalizeTarEntryPath(
      entry,
      "prepared source tar entry",
    );
    if (seen.has(normalized)) {
      throw new Error(
        `prepared source tar entry duplicates normalized path: ${entry}`,
      );
    }
    seen.add(normalized);
  }
  const verbose = await runTar(
    compressed ? ["-t", "-v", "-z", "-f", "-"] : ["-t", "-v", "-f", "-"],
    bytes,
  );
  for (const line of verbose.split(/\r?\n/)) {
    if (line.length === 0) continue;
    assertSafeTarLinkTarget(line, "prepared source tar entry");
  }
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
  const child = new Deno.Command("tar", {
    args: [...args],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
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
