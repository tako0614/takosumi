/**
 * Prepared source reader for runtime-agent connectors.
 *
 * Source-backed connectors read files from an already-prepared source snapshot
 * instead of fetching artifact payloads by hash. Co-located agents can receive
 * a `workingDirectory`; remote agents can receive `url` + `digest` for a tar
 * snapshot that is verified and extracted per apply request.
 */

import type { PreparedSourceLocator } from "takosumi-contract/reference/compat";

export interface PreparedSourceReader {
  readFile(path: string): Promise<Uint8Array>;
}

export interface PreparedSourceContext {
  readonly reader: PreparedSourceReader;
  readonly cleanup: () => Promise<void>;
}

export async function sourceContextFromLocator(
  locator: PreparedSourceLocator | undefined,
): Promise<PreparedSourceContext | undefined> {
  if (!locator) return undefined;
  if (locator.workingDirectory) {
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
  const destination = await Deno.makeTempDir({
    prefix: "takosumi-runtime-agent-source-",
  });
  try {
    const compressed = isGzipArchive(locator.url);
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
    await Deno.remove(destination, { recursive: true }).catch(() => {});
    throw err;
  }
  return {
    reader: new LocalPreparedSourceReader(destination),
    cleanup: () => Deno.remove(destination, { recursive: true }),
  };
}

export class LocalPreparedSourceReader implements PreparedSourceReader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root.replace(/\/+$/, "");
  }

  readFile(path: string): Promise<Uint8Array> {
    return Deno.readFile(`${this.#root}/${normalizeRelativePath(path)}`);
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
  if (url.startsWith("https://") || url.startsWith("http://")) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `failed to fetch preparedSource ${url}: ${response.status} ${response.statusText}`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  if (url.startsWith("file://")) {
    return await Deno.readFile(decodeURIComponent(new URL(url).pathname));
  }
  return await Deno.readFile(url);
}

function isGzipArchive(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.endsWith(".tgz") || lower.endsWith(".tar.gz");
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
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
    const normalized = normalizeTarEntryPath(entry, "preparedSource tar entry");
    if (seen.has(normalized)) {
      throw new Error(
        `preparedSource tar entry duplicates normalized path: ${entry}`,
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
    assertSafeTarLinkTarget(line, "preparedSource tar entry");
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
