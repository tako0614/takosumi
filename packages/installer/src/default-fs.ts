/**
 * Installer-local default {@link InstallerFs} (Deno runtime path).
 *
 * Takosumi is consumed as a framework library: the temp-dir FS capability the
 * source fetchers need is *injected* by the implementation. The reference
 * kernel injects `currentRuntime().fs` (an `FsAdapter` that runs on Deno /
 * Node / Workers). This module is only the fallback used when no FS is
 * injected — for example the installer's own standalone Deno tests — so the
 * historical `Deno.makeTempDir` / `Deno.remove` / `Deno.mkdir` behavior is
 * unchanged.
 *
 * Unlike the git / tar subprocess primitives (which are dnt-mapped to Node
 * implementations), these `Deno.*` FS calls are covered by dnt's `@deno/shim-deno`
 * (`shims: { deno: true }`), so the npm build runs them through the shim
 * without a `.node.ts` mapping. In production the reference kernel injects
 * `currentRuntime().fs`, so this default is not on the hot path there.
 */

import type { InstallerFs } from "@takos/takosumi-contract/reference/runtime-capability";

export const defaultInstallerFs: InstallerFs = {
  makeTempDir(prefix) {
    return Deno.makeTempDir(prefix !== undefined ? { prefix } : undefined);
  },
  remove(path, options) {
    return Deno.remove(path, options);
  },
  mkdir(path, options) {
    return Deno.mkdir(path, options);
  },
};
