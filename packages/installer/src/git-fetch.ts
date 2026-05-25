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
 */
export async function fetchGitSource(
  options: GitFetchOptions,
): Promise<GitFetchResult> {
  const destination = options.destination ??
    (await Deno.makeTempDir({ prefix: "takosumi-installer-" }));
  const ref = options.ref ?? "HEAD";
  const depth = options.depth ?? 1;

  if (ref === "HEAD") {
    await runGit([
      "clone",
      "--depth",
      String(depth),
      options.url,
      destination,
    ]);
  } else if (isFullGitSha(ref)) {
    await runGit([
      "clone",
      options.url,
      destination,
    ]);
    await runGit([
      "checkout",
      "--detach",
      ref,
    ], destination);
  } else {
    await runGit([
      "clone",
      "--depth",
      String(depth),
      "--branch",
      ref,
      options.url,
      destination,
    ]);
  }

  const commit = (await runGit(["rev-parse", "HEAD"], destination)).trim();

  return {
    workingDirectory: destination,
    commit,
    ref,
    cleanup: () => Deno.remove(destination, { recursive: true }),
  };
}

function isFullGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

async function runGit(args: readonly string[], cwd?: string): Promise<string> {
  const command = new Deno.Command("git", {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}
