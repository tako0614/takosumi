/**
 * Git source fetcher for the deployControl.
 *
 * Clones a git URL at a specific ref (branch / tag / commit), returns the
 * resolved commit SHA and a path to the working tree. Caller is responsible
 * for cleanup after planning and applying the source.
 *
 * This module replaces the prior external git-source helper.
 */

import type {
  GitInvocationResult,
  GitRunner,
  DeployControlFs,
} from "takosumi-contract/reference/runtime-capability";
import { assertHostNotBlocked, BlockedHostError } from "./host-blocklist.ts";
import { defaultDeployControlFs } from "./default-fs.ts";
import { defaultGitRunner } from "./subprocess/git-runner.ts";

export interface GitFetchOptions {
  readonly url: string;
  readonly ref?: string;
  readonly destination?: string;
  readonly depth?: number;
  /**
   * Injected `git` capability. Defaults to a runner built over the deploy control
   * local `git` primitive; the
   * reference service injects a runner routed through
   * `currentRuntime().subprocess` so the same path runs on Node / Workers
   * without this module referencing host subprocess globals.
   */
  readonly gitRunner?: GitRunner;
  /**
   * Injected temp-dir filesystem capability. Defaults to the local Node/Bun
   * filesystem implementation; the reference service injects `currentRuntime().fs`.
   */
  readonly fs?: DeployControlFs;
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
 * `expected.sourceCommit` in the deploy control API.
 *
 * Implementation note: this is a thin wrapper over `git clone` /
 * `git rev-parse HEAD` invoked through the injected {@link GitRunner}
 * (defaulting to the deploy control local `git` primitive). It
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
 *   resolved here; operators are expected to constrain the service's
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
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const fs = options.fs ?? defaultDeployControlFs;

  const ownsDestination = options.destination === undefined;
  const destination = options.destination ??
    (await fs.makeTempDir("takosumi-deploy-control-"));

  let consumed = false;
  const cleanupOnce = createOnceCleanup(fs, destination);
  try {
    if (ref === "HEAD") {
      await runGit(gitRunner, [
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
      const filteredClone = await tryRunGit(gitRunner, [
        "clone",
        "--filter=blob:limit=100m",
        "--no-checkout",
        "--",
        options.url,
        destination,
      ]);
      if (!filteredClone.ok) {
        await fs.remove(destination, { recursive: true }).catch(() => {});
        await fs.mkdir(destination, { recursive: true });
        await runGit(gitRunner, [
          "clone",
          "--depth",
          "50",
          "--no-checkout",
          "--",
          options.url,
          destination,
        ]);
      }
      await runGit(gitRunner, [
        "checkout",
        "--detach",
        ref,
      ], destination);
    } else {
      await runGit(gitRunner, [
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

    const commit = (await runGit(gitRunner, ["rev-parse", "HEAD"], destination))
      .trim();

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

function createOnceCleanup(
  fs: DeployControlFs,
  destination: string,
): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await fs.remove(destination, { recursive: true }).catch(() => {});
  };
}

function isFullGitSha(value: string): boolean {
  // 40-hex SHA-1 or 64-hex SHA-256 object IDs. SHA-256 commits must take the
  // same no-checkout + detached-checkout path as SHA-1 commits because a raw
  // object id is not a branch/tag and cannot be passed to `clone --branch`.
  return /^[0-9a-f]{40}$/i.test(value) || /^[0-9a-f]{64}$/i.test(value);
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
    assertGitHostNotBlocked(host);
    return;
  }
  if (isSshShorthand(url)) {
    const host = extractSshShorthandHost(url);
    assertGitHostNotBlocked(host);
    return;
  }
  throw new Error(
    `git source url scheme is not allowed (must be https:// or git@host:path): ${url}`,
  );
}

function assertGitHostNotBlocked(host: string): void {
  try {
    assertHostNotBlocked(host, "git source host");
  } catch (err) {
    if (err instanceof BlockedHostError) {
      // Preserve the established message ("git source host is not allowed").
      throw new Error(err.message);
    }
    throw err;
  }
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
  // everything from `[` through `]` as the host so the blocklist can strip
  // the brackets cleanly. Without this, the first `:` inside `[::1]` would
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

async function runGit(
  gitRunner: GitRunner,
  args: readonly string[],
  cwd?: string,
): Promise<string> {
  const result = await tryRunGit(gitRunner, args, cwd);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function tryRunGit(
  gitRunner: GitRunner,
  args: readonly string[],
  cwd?: string,
): Promise<GitInvocationResult> {
  return gitRunner.run(args, cwd);
}
