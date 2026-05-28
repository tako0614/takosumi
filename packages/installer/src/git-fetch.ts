/**
 * Git source fetcher for the installer.
 *
 * Clones a git URL at a specific ref (branch / tag / commit), returns the
 * resolved commit SHA and a path to the working tree. Caller is
 * responsible for cleanup after reading `.takosumi.yml` and building
 * artifacts.
 *
 * This module replaces the prior external git-source helper.
 */

export interface GitFetchOptions {
  readonly url: string;
  readonly ref?: string;
  readonly destination?: string;
  readonly depth?: number;
}

export interface GitFetchResult {
  readonly workingDirectory: string;
  readonly commit: string;
  readonly ref: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Clone a git repository to a temp directory and check out the
 * requested ref. Returns the resolved commit SHA so callers can pin
 * `expected.commit` in the installer API.
 *
 * Implementation note: this is a thin wrapper over `git clone` /
 * `git rev-parse HEAD` invoked through the Deno `Command` API. It
 * intentionally does not depend on third-party git libraries —
 * `git` must be on the operator's PATH.
 *
 * Security notes:
 * - Only `https://` and `git@` SSH-shorthand source URLs are accepted.
 *   Schemes that allow local or unauthenticated reads (`file://`,
 *   `git://`, `ssh://`, `http://`) or raw filesystem paths are rejected.
 * - `url` and `ref` values starting with `-` are rejected so they cannot
 *   be interpreted as git CLI option flags. Control characters are also
 *   rejected so they cannot smuggle a newline / NUL into the argv.
 * - Host literals that resolve to loopback, RFC1918 private, link-local,
 *   or cloud metadata IPs are rejected up front. DNS hostnames are not
 *   resolved here; operators are expected to constrain the kernel's
 *   network egress to trusted destinations.
 */
export async function fetchGitSource(
  options: GitFetchOptions,
): Promise<GitFetchResult> {
  assertSafeGitArgument(options.url, "git source url");
  assertAllowedGitUrl(options.url);
  const requestedRef = options.ref ?? "HEAD";
  if (options.ref !== undefined) {
    assertSafeGitArgument(options.ref, "git source ref");
  }
  const ref = requestedRef;
  const depth = options.depth ?? 1;

  const ownsDestination = options.destination === undefined;
  const destination = options.destination ??
    (await Deno.makeTempDir({ prefix: "takosumi-installer-" }));

  let consumed = false;
  const cleanupOnce = createOnceCleanup(destination);
  try {
    if (ref === "HEAD") {
      await runGit([
        "clone",
        "--depth",
        String(depth),
        "--",
        options.url,
        destination,
      ]);
    } else if (isFullGitSha(ref)) {
      // Full SHA may not be reachable from the default branch tip, so we
      // cannot use `--depth` here. To avoid pulling unbounded history we
      // try a partial-clone filter first; if the server / client does not
      // support it we fall back to a shallow `--depth 50` window.
      const filteredClone = await tryRunGit([
        "clone",
        "--filter=blob:limit=100m",
        "--no-checkout",
        "--",
        options.url,
        destination,
      ]);
      if (!filteredClone.ok) {
        await Deno.remove(destination, { recursive: true }).catch(() => {});
        await Deno.mkdir(destination, { recursive: true });
        await runGit([
          "clone",
          "--depth",
          "50",
          "--no-checkout",
          "--",
          options.url,
          destination,
        ]);
      }
      await runGit([
        "checkout",
        "--detach",
        "--",
        ref,
      ], destination);
    } else {
      await runGit([
        "clone",
        "--depth",
        String(depth),
        "--branch",
        ref,
        "--",
        options.url,
        destination,
      ]);
    }

    const commit = (await runGit(["rev-parse", "HEAD"], destination)).trim();

    const result: GitFetchResult = {
      workingDirectory: destination,
      commit,
      ref,
      cleanup: cleanupOnce,
    };
    consumed = true;
    return result;
  } finally {
    // If we created the destination but the caller never received a result
    // (constructor threw), drop the temp tree so the operator does not
    // accumulate half-cloned working directories.
    if (!consumed && ownsDestination) {
      await cleanupOnce().catch(() => {});
    }
  }
}

function createOnceCleanup(destination: string): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await Deno.remove(destination, { recursive: true }).catch(() => {});
  };
}

function isFullGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function assertSafeGitArgument(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with '-'`);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }
}

function assertAllowedGitUrl(url: string): void {
  if (url.startsWith("https://")) {
    const host = extractHttpsHost(url);
    if (host === null) {
      throw new Error(`git source url has no host: ${url}`);
    }
    assertHostNotBlocked(host);
    return;
  }
  if (isSshShorthand(url)) {
    const host = extractSshShorthandHost(url);
    assertHostNotBlocked(host);
    return;
  }
  throw new Error(
    `git source url scheme is not allowed (must be https:// or git@host:path): ${url}`,
  );
}

function extractHttpsHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSshShorthand(url: string): boolean {
  // git@host:path form; reject `ssh://...` explicitly so callers cannot
  // hide a path traversal behind the SSH scheme parser.
  if (url.startsWith("ssh://")) return false;
  const match = url.match(/^[A-Za-z0-9_.-]+@([A-Za-z0-9_.:\[\]-]+):/);
  return match !== null;
}

function extractSshShorthandHost(url: string): string {
  const at = url.indexOf("@");
  // Bracketed IPv6 literal: git@[::1]:path. Find the matching `]` and treat
  // everything from `[` through `]` as the host so `stripIpv6Brackets` can
  // remove them cleanly. Without this, the first `:` inside `[::1]` would
  // truncate the host to `[` and bypass the loopback check.
  if (url[at + 1] === "[") {
    const closingBracket = url.indexOf("]", at + 2);
    if (closingBracket === -1) {
      throw new Error(`git source url has unmatched IPv6 bracket: ${url}`);
    }
    return url.slice(at + 1, closingBracket + 1).toLowerCase();
  }
  const colon = url.indexOf(":", at + 1);
  return url.slice(at + 1, colon).toLowerCase();
}

function assertHostNotBlocked(host: string): void {
  const literal = stripIpv6Brackets(host);
  if (isIpv4Literal(literal)) {
    if (isBlockedIpv4(literal)) {
      throw new Error(`git source host is not allowed: ${host}`);
    }
    return;
  }
  if (isIpv6Literal(literal)) {
    if (isBlockedIpv6(literal)) {
      throw new Error(`git source host is not allowed: ${host}`);
    }
    return;
  }
  // Hostnames are not resolved here. Operators control egress.
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

function isIpv6Literal(value: string): boolean {
  return value.includes(":");
}

function isBlockedIpv4(value: string): boolean {
  const parts = value.split(".").map((segment) => Number.parseInt(segment, 10));
  if (
    parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    // Malformed literal — treat as blocked to fail closed.
    return true;
  }
  const [a, b, , d] = parts;
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
  if (a === 255 && b === 255 && parts[2] === 255 && d === 255) return true;
  return false;
}

function isBlockedIpv6(value: string): boolean {
  const lower = value.toLowerCase();
  // ::1 loopback
  if (lower === "::1") return true;
  if (lower === "::") return true;
  // fc00::/7 unique local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  // ff00::/8 multicast
  if (lower.startsWith("ff")) return true;
  // IPv6-mapped IPv4 ::ffff:a.b.c.d — re-check against IPv4 rules
  const mappedDotted = lower.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (mappedDotted && isBlockedIpv4(mappedDotted[1])) return true;
  // IPv6-mapped IPv4 in hex form: ::ffff:7f00:1 == ::ffff:127.0.0.1
  // Two hex groups of 1-4 chars each follow the ::ffff: marker.
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    if (
      Number.isFinite(high) && Number.isFinite(low) &&
      high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff
    ) {
      const reconstructed = `${(high >> 8) & 0xff}.${high & 0xff}.${
        (low >> 8) & 0xff
      }.${low & 0xff}`;
      if (isBlockedIpv4(reconstructed)) return true;
    }
  }
  // Deprecated IPv4-compatible form ::a.b.c.d (no ffff prefix), as written.
  const compatDotted = lower.match(
    /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (compatDotted && isBlockedIpv4(compatDotted[1])) return true;
  // Same deprecated form after URL normalization: `::a.b.c.d` is rewritten by
  // the URL parser to `::HHHH:HHHH` where HHHH:HHHH is the hex packing of the
  // IPv4 octets, e.g. `::127.0.0.1` -> `::7f00:1`. We treat any `::HHHH:HHHH`
  // value (other than the already-handled `::1` and `::ffff:...` cases) as a
  // candidate IPv4-compatible form and reject it if the reconstructed IPv4
  // dotted address is blocked. The `::/96` range is reserved by IANA, so a
  // false positive on legitimate addresses here is acceptable.
  const compatHex = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (compatHex) {
    const high = Number.parseInt(compatHex[1], 16);
    const low = Number.parseInt(compatHex[2], 16);
    if (
      Number.isFinite(high) && Number.isFinite(low) &&
      high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff
    ) {
      const reconstructed = `${(high >> 8) & 0xff}.${high & 0xff}.${
        (low >> 8) & 0xff
      }.${low & 0xff}`;
      if (isBlockedIpv4(reconstructed)) return true;
    }
  }
  // Cloud metadata fd00:ec2::254 lives inside fc00::/7 already.
  return false;
}

interface GitInvocationResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(args: readonly string[], cwd?: string): Promise<string> {
  const result = await tryRunGit(args, cwd);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

async function tryRunGit(
  args: readonly string[],
  cwd?: string,
): Promise<GitInvocationResult> {
  const command = new Deno.Command("git", {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const decoder = new TextDecoder();
  return {
    ok: code === 0,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}
