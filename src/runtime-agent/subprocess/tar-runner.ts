/**
 * `tar` subprocess primitive for the runtime-agent prepared-source reader.
 *
 * The runtime-detecting `tar` primitive itself lives in the neutral leaf module
 * `../../shared/subprocess/tar-runner.ts` (shared with the installer so the two
 * sibling layers do not have to import each other). This module re-exports
 * {@link runTarCommand} so `capability_runners.ts` keeps consuming it through
 * the runtime-agent's existing path.
 */

export { runTarCommand } from "../../shared/subprocess/tar-runner.ts";
