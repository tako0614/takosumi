// runner/lib/policy.ts
//
// Security policy: SSRF host-blocklist, DNS-rebind, git selectors, tar/zstd safety, path jails.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import { isAbsolute, normalize } from "node:path";
import { lookup } from "node:dns/promises";
import {
  assertHostNotBlocked,
  BlockedHostError,
} from "../../contract/reference/host-blocklist.ts";
import type { CommandContext, TarVerboseEntry } from "./types.ts";
import {
  RUN_ROOT,
  DEFAULT_SOURCE_ARCHIVE_MAX_DECOMPRESSED_BYTES,
  INTERNAL_NAME_SUFFIXES,
} from "./constants.ts";
import { runCommand } from "./exec.ts";

// URL policy (spec 7.1): allow https://host/path(.git), ssh://git@host/...,
// git@host:path. Forbid file://, absolute/relative filesystem paths, git://,
// ext::, and embedded credentials (user:pass@).
export function assertSourceUrlPolicy(url: string): void {
  if (url.length === 0) throw new Error("source url must not be empty");
  if (/[\\\r\n\0]/.test(url)) {
    throw new Error("source url is malformed");
  }
  const lower = url.toLowerCase();
  if (lower.startsWith("file://")) {
    throw new Error("source url scheme file:// is forbidden");
  }
  if (lower.startsWith("git://")) {
    throw new Error("source url scheme git:// is forbidden");
  }
  if (lower.startsWith("ext::")) {
    throw new Error("source url transport ext:: is forbidden");
  }
  // scp-like shorthand: git@host:path (no scheme, single colon before path).
  const scpLike = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(url);
  if (scpLike && !url.includes("://")) {
    const user = scpLike[1]!;
    const host = scpLike[2]!;
    const remotePath = scpLike[3]!;
    if (user.includes(":")) {
      throw new Error("source url must not embed credentials");
    }
    if (host.length === 0 || remotePath.length === 0) {
      throw new Error("source url is malformed");
    }
    assertSourceHostAllowed(host);
    if (/[\r\n\0]/.test(url) || url.startsWith("-")) {
      throw new Error("source url contains control characters");
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      "source url must be a valid https/ssh URL or git@host:path",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new Error(`source url scheme ${parsed.protocol} is forbidden`);
  }
  if (parsed.username || parsed.password) {
    // ssh://git@host carries only a username (the ssh login, conventionally
    // "git") and no password; that is allowed. A password is always rejected.
    if (parsed.password) {
      throw new Error("source url must not embed credentials");
    }
    if (parsed.protocol === "https:" && parsed.username) {
      throw new Error("source url must not embed credentials");
    }
  }
  if (!parsed.hostname) throw new Error("source url must include a host");
  assertSourceHostAllowed(parsed.hostname);
  if (/[\r\n\0]/.test(url)) {
    throw new Error("source url contains control characters");
  }
}

export function assertSourceHostAllowed(host: string): void {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    throw new Error("source url host is blocked");
  }
  try {
    assertHostNotBlocked(host, "source URL host");
  } catch (error) {
    if (error instanceof BlockedHostError) {
      throw new Error("source url host is blocked");
    }
    throw error;
  }
}

// The source subtree path is a relative path INSIDE the cloned repo. Reject
// absolute paths and any traversal so a job can only ever archive a directory
// that lives under the checkout.
export function normalizeSourceSubtreePath(path: string): string {
  if (path === "" || path === ".") return ".";
  if (isAbsolute(path) || path.includes("\0") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(
      `source_sync.source.path is not a safe relative path: ${path}`,
    );
  }
  const normalized = normalize(path)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(
      `source_sync.source.path is not a safe relative path: ${path}`,
    );
  }
  return normalized;
}

// The R2_SOURCE archive object key (agreed layout
// workspaces/{workspaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst) is
// allocated by the host and persisted by the DO. The runner forwards it to the
// DO; re-assert here that it is a safe, traversal-free relative key.
export function assertSafeArchiveObjectKey(key: string): void {
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("\0") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.startsWith("workspaces/") === false
  ) {
    throw new Error(`unsafe source archive object key: ${key}`);
  }
}

// Minted credential files are referenced only by basename inside the per-run
// credential dir; reject anything with a separator/traversal so a job can never
// write outside that dir.
export function assertSafeCredentialFileName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    isAbsolute(name)
  ) {
    throw new Error(`source_sync credential file path is unsafe: ${name}`);
  }
}

export function assertSafeCredentialFileMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0o400 || mode > 0o700) {
    throw new Error(`source_sync credential file mode is unsafe: ${mode}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `source_sync credential file mode is group/world-readable: ${mode}`,
    );
  }
}

// A remote_state dependency name must be a single safe path segment so it can
// only ever name <depsDir>/<name>.tfstate. Reject empty / traversal / separator
// / NUL / drive-letter names (the producer Capsule name is `[a-z0-9-]`-ish,
// but harden against a crafted dispatch).
export function safeDepName(name: string): string {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    isAbsolute(name) ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`unsafe dependency state name: ${name}`);
  }
  return name;
}

// Tar-slip / link-target / zip-bomb hardening for the zstd-compressed
// source_sync archive format. Reuses the shared
// per-entry validators (escape quoting, duplicate normalized paths, file/dir
// only, decompressed-size cap).
export async function assertSafeZstdTarArchive(
  archivePath: string,
  context: CommandContext,
): Promise<void> {
  const verbose = await runCommand(
    ["tar", "-t", "-v", "--quoting-style=escape", "--zstd", "-f", archivePath],
    { cwd: RUN_ROOT, context },
  );
  if (verbose.exitCode !== 0) {
    throw new Error(
      `source archive metadata list failed: ${verbose.stderr || verbose.stdout}`,
    );
  }
  const seenPaths = new Set<string>();
  let decompressedBytes = 0;
  for (const line of verbose.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const entry = parseTarVerboseLine(line);
    if (!entry) {
      throw new Error(
        `source archive has an unparseable metadata line: ${line}`,
      );
    }
    const normalizedPath = normalizeSourceArchiveEntryPath(entry.path);
    // The deterministic source archive carries a single `./` root dir entry;
    // skip it from the duplicate set but still validate it is the safe root.
    if (normalizedPath !== "") {
      if (seenPaths.has(normalizedPath)) {
        throw new Error(
          `source archive duplicates normalized path: ${entry.path}`,
        );
      }
      seenPaths.add(normalizedPath);
    }
    if (entry.type !== "-" && entry.type !== "d") {
      throw new Error(
        `source archive contains unsupported entry type: ${entry.type}`,
      );
    }
    decompressedBytes += entry.size;
    const decompressedCap =
      context.sourceArchiveMaxDecompressedBytes ??
      DEFAULT_SOURCE_ARCHIVE_MAX_DECOMPRESSED_BYTES;
    if (decompressedBytes > decompressedCap) {
      throw new Error(
        `source archive decompresses to more than ${decompressedCap} bytes`,
      );
    }
  }
}

// The deterministic source archive may contain a `.` / `./` root entry (which
// maps to ""). Every other entry must be a traversal-free, absolute-free
// relative path so extraction stays inside /work/source.
export function normalizeSourceArchiveEntryPath(path: string): string {
  if (path === "." || path === "./") return "";
  if (path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`source archive contains unsafe path: ${path}`);
  }
  const normalized = normalize(path)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`source archive contains unsafe path: ${path}`);
  }
  return normalized;
}

export function parseTarVerboseLine(line: string): TarVerboseEntry | undefined {
  const columns = line.split(/\s+/);
  if (columns.length < 6) return undefined;
  const rawSize = Number.parseInt(columns[2] ?? "0", 10);
  const size = Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 0;
  let cursor = 0;
  let column = 0;
  while (column < 5 && cursor < line.length) {
    while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor += 1;
    while (cursor < line.length && !/\s/.test(line[cursor] ?? "")) cursor += 1;
    column += 1;
  }
  while (cursor < line.length && /\s/.test(line[cursor] ?? "")) cursor += 1;
  const path = line.slice(cursor);
  if (!path) return undefined;
  return { type: line[0] ?? "", path, size };
}

/** Operator/runner-owned DNS resolution seam used by the SSRF pre-flight. */
export type HostAddressResolver = (host: string) => Promise<readonly string[]>;

export async function assertResolvedHostNotBlocked(
  host: string,
  label: string,
  resolveAddresses: HostAddressResolver = resolveHostAddresses,
): Promise<void> {
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IP literals are already fully covered by assertHostLiteralNotBlocked.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(literal) || literal.includes(":")) {
    return;
  }
  const lower = literal.toLowerCase();
  if (lower === "localhost" || INTERNAL_NAME_SUFFIXES.test(lower)) {
    throw new Error(`${label} is an internal-only name: ${host}`);
  }
  const addresses = await resolveAddresses(literal);
  if (addresses.length === 0) {
    throw new Error(
      `${label} could not be resolved for SSRF validation: ${host}`,
    );
  }
  for (const addr of addresses) {
    if (isBlockedIpv4Literal(addr) || isBlockedIpv6Literal(addr)) {
      throw new Error(
        `${label} resolves to a blocked address (${addr}): ${host}`,
      );
    }
  }
}

/**
 * Resolve every address returned by the runner substrate's system resolver.
 *
 * This intentionally uses the runtime resolver (including operator-controlled
 * `/etc/hosts`, split DNS, and resolver policy) instead of coupling the generic
 * runner to a specific public DNS-over-HTTPS service.
 */
export async function resolveHostAddresses(host: string): Promise<string[]> {
  try {
    const results = await lookup(host, { all: true, verbatim: true });
    return [...new Set(results.map((result) => result.address.trim()))].filter(
      (address) => address.length > 0,
    );
  } catch {
    // Treat a failed lookup as "unresolved"; the caller fails closed.
    return [];
  }
}

export function assertSafeGitSelector(value: string, label: string): void {
  if (value.startsWith("-") || /[\r\n\0]/.test(value)) {
    throw new Error(
      `${label} must not start with '-' or contain control characters`,
    );
  }
}

export function assertHostLiteralNotBlocked(host: string, label: string): void {
  const literal =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = literal.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error(`${label} is not allowed: ${host}`);
  }
  if (isBlockedIpv4Literal(lower) || isBlockedIpv6Literal(lower)) {
    throw new Error(`${label} is not allowed: ${host}`);
  }
}

export function isBlockedIpv4Literal(value: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c, d] = parts;
  if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return a === 255 && b === 255 && c === 255 && d === 255;
}

export function isBlockedIpv6Literal(value: string): boolean {
  if (!value.includes(":")) return false;
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith("ff")) return true;
  if (value.startsWith("::ffff:")) {
    return isBlockedIpv4Literal(value.slice("::ffff:".length));
  }
  return false;
}

export function assertGeneratedRootFileName(name: string): void {
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".." ||
    isAbsolute(name)
  ) {
    throw new Error(`generatedRoot.files key is not a safe filename: ${name}`);
  }
}

export function assertSafeRelativePath(path: string, label: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    throw new Error(`${label} must be a relative path inside the source root`);
  }
  const normalized = normalize(path).replaceAll("\\", "/");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`${label} must not escape the source root`);
  }
}
