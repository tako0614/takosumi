/**
 * Installer-local default `tar` capability (runtime-detecting).
 *
 * This is the fallback `TarRunner` used when no runner is injected — for
 * example the installer's own standalone Deno tests. The runtime-detecting
 * `tar` primitive itself lives in the neutral leaf module
 * `../../shared/subprocess/tar-runner.ts` (shared with the runtime-agent so the
 * two sibling layers do not have to import each other), and this module wraps
 * it as the injected {@link TarRunner} interface.
 *
 * In production the reference service injects a `TarRunner` routed through
 * `currentRuntime().subprocess`, so callers no longer reference this fallback.
 */

import type { TarRunner } from "takosumi-contract/reference/runtime-capability";
import { runTarCommand } from "../../shared/subprocess/tar-runner.ts";

/**
 * Default `TarRunner` over the shared runtime-detecting `tar` primitive.
 * Wraps {@link runTarCommand} so the prepared-source fetcher consumes the
 * injected {@link TarRunner} interface.
 */
export const defaultTarRunner: TarRunner = {
  run(args, stdin) {
    return runTarCommand(args, stdin);
  },
};
