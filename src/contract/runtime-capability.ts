/**
 * Runtime-capability interfaces — injected subprocess primitives the installer
 * needs but the Takosumi *framework library* must not call directly.
 *
 * Takosumi is consumed as a framework: runtime capabilities (git / tar
 * subprocess, temp-dir FS, HTTP serve) are *injected* by the implementation
 * rather than reached through `Deno.*` / `node:*` inside the library surface.
 * These interfaces are the contract between the installer (which consumes a
 * git / tar runner) and whatever the operator wires in.
 *
 * The reference kernel provides a default implementation built over the
 * `RuntimeAdapter` `SubprocessAdapter` (see
 * `src/kernel/shared/runtime/capability-runners.ts`), so the Deno
 * runtime behavior is unchanged: the default runner routes through
 * `currentRuntime().subprocess`, which already has Deno / Node / Workers
 * implementations.
 *
 * Result shapes are intentionally identical to the installer's existing
 * `runGitCommand` / `runTarCommand` shapes so wiring a runner is a drop-in.
 */

/**
 * Result of a single `git` invocation. Structurally identical to the
 * installer's historical `GitInvocationResult` so the installer can adopt this
 * interface without changing call sites.
 */
export interface GitInvocationResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Injected `git` capability. Runs `git <args>` (optionally in `cwd`) and
 * returns the decoded stdout / stderr plus an `ok` flag (`exit code === 0`).
 *
 * The default implementation routes through the `RuntimeAdapter`
 * `SubprocessAdapter`; an operator may inject any implementation with the same
 * observable behavior (e.g. one that shells out through a remote build host).
 */
export interface GitRunner {
  run(args: readonly string[], cwd?: string): Promise<GitInvocationResult>;
}

/**
 * Injected `tar` capability. Pipes `stdin` (the archive bytes) to `tar <args>`
 * and resolves with the decoded stdout; rejects when `tar` exits non-zero.
 *
 * Implementations MUST force a deterministic C locale (`LC_ALL=C` / `LANG=C`)
 * so the `tar -tv` column format does not shift with the operator's
 * LANG / LC_TIME settings — this is required for the installer's column
 * parser. The default implementation does this via the `SubprocessAdapter`
 * `env` option.
 */
export interface TarRunner {
  run(args: readonly string[], stdin: Uint8Array): Promise<string>;
}

/**
 * Injected temp-dir filesystem capability the installer needs to stage a git /
 * prepared source checkout before deriving an install plan. The installer must
 * not reach for `Deno.makeTempDir` / `node:fs` directly; the reference kernel
 * injects `currentRuntime().fs`, whose `FsAdapter` structurally satisfies this
 * subset (`makeTempDir` / `remove` / `mkdir`).
 *
 * The three members mirror the historical `Deno.makeTempDir({ prefix })` /
 * `Deno.remove(path, { recursive })` / `Deno.mkdir(path, { recursive })`
 * behavior exactly so wiring an FS is a drop-in and legacy filesystem behavior
 * is unchanged.
 */
export interface InstallerFs {
  /**
   * Create a uniquely-named temporary directory whose basename starts with
   * `prefix` and return its absolute path. Mirrors `Deno.makeTempDir({ prefix })`.
   */
  makeTempDir(prefix?: string): Promise<string>;
  /**
   * Remove a file or directory. With `{ recursive: true }` the entire tree is
   * removed. Mirrors `Deno.remove(path, { recursive })`.
   */
  remove(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  /**
   * Create a directory (with `{ recursive: true }` to create parents). Mirrors
   * `Deno.mkdir(path, { recursive })`.
   */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}
