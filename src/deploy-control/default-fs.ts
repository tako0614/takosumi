/**
 * Deploy control local default {@link DeployControlFs}.
 *
 * The reference service injects its runtime adapter filesystem. This fallback
 * exists for standalone deploy control consumers and tests. It uses
 * Node-compatible filesystem APIs, which are available in Bun.
 */

import type { DeployControlFs } from "takosumi-contract/reference/runtime-capability";

export const defaultDeployControlFs: DeployControlFs = {
  async makeTempDir(prefix) {
    const [{ mkdtemp }, { tmpdir }, { join }] = await Promise.all([
      import("node:fs/promises"),
      import("node:os"),
      import("node:path"),
    ]);
    return await mkdtemp(join(tmpdir(), prefix ?? "takosumi-deploy-control-"));
  },
  async remove(path, options) {
    const { rm } = await import("node:fs/promises");
    await rm(path, { recursive: options?.recursive === true, force: true });
  },
  async mkdir(path, options) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: options?.recursive === true });
  },
};
