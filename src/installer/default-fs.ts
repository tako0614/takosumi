/**
 * Installer-local default {@link InstallerFs}.
 *
 * The reference kernel injects its runtime adapter filesystem. This fallback
 * exists for standalone installer consumers and tests; it detects the host at
 * call time and uses the compatible filesystem API available there.
 */

import type { InstallerFs } from "takosumi-contract/reference/runtime-capability";

interface DenoLikeFs {
  makeTempDir(options?: { prefix?: string }): Promise<string>;
  remove(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
}

function denoLikeFs(): DenoLikeFs | undefined {
  const candidate = (globalThis as { Deno?: Partial<DenoLikeFs> }).Deno;
  if (
    typeof candidate?.makeTempDir === "function" &&
    typeof candidate.remove === "function" &&
    typeof candidate.mkdir === "function"
  ) {
    return candidate as DenoLikeFs;
  }
  return undefined;
}

export const defaultInstallerFs: InstallerFs = {
  async makeTempDir(prefix) {
    const runtime = denoLikeFs();
    if (runtime) {
      return await runtime.makeTempDir(
        prefix !== undefined ? { prefix } : undefined,
      );
    }
    const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ]);
    return await mkdtemp(join(tmpdir(), prefix ?? "takosumi-installer-"));
  },
  async remove(path, options) {
    const runtime = denoLikeFs();
    if (runtime) {
      await runtime.remove(path, options);
      return;
    }
    const { rm } = await import("node:fs/promises");
    await rm(path, { recursive: options?.recursive === true, force: true });
  },
  async mkdir(path, options) {
    const runtime = denoLikeFs();
    if (runtime) {
      await runtime.mkdir(path, options);
      return;
    }
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: options?.recursive === true });
  },
};
