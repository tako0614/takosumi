/**
 * Default runtime-capability runners for the generic runtime-agent package.
 *
 * Takosumi is consumed as a framework: runtime capabilities (here, the `tar`
 * subprocess used to verify and extract a prepared-source snapshot) are
 * *injected* through the `takosumi-contract` capability interfaces rather than
 * reached through `Deno.*` / `node:*` directly in the library surface. The
 * `sourceContextFromLocator` reader accepts an injected `TarRunner`; this
 * module provides the default the runtime-agent wires in when an operator does
 * not supply one.
 *
 * The runtime-agent sits UPSTREAM of the kernel in the dependency graph, so it
 * cannot reuse the kernel's `defaultTarRunner`
 * (`src/kernel/shared/runtime/capability-runners.ts`) without
 * inverting the layering / creating an import cycle. The default here is
 * therefore built over the runtime-agent's own local subprocess primitive
 * (`./subprocess/tar-runner.ts`), which is a single runtime-detecting module:
 * it runs `tar` through `Deno.Command` on Deno and through `node:child_process`
 * on Node, selecting the path at call time (the npm build keeps this local runtime boundary). Behavior is byte-for-byte identical to the
 * historical direct `runTarCommand` call: same args, same stdin piping, same
 * forced `LC_ALL=C` / `LANG=C` C locale, and the same `tar <args> failed:
 * <stderr>` error on a non-zero exit.
 */

import type { TarRunner } from "takosumi-contract/reference/runtime-capability";
import { runTarCommand } from "./subprocess/tar-runner.ts";

/**
 * Build a `TarRunner` over the runtime-agent's local `tar` subprocess
 * primitive. Exposed so callers / tests can construct the default explicitly.
 */
export function createSubprocessTarRunner(): TarRunner {
  return {
    run(args: readonly string[], stdin: Uint8Array): Promise<string> {
      return runTarCommand(args, stdin);
    },
  };
}

/**
 * The default `TarRunner` the runtime-agent uses when an operator does not
 * inject one. Routes through the local subprocess primitive.
 */
export const defaultTarRunner: TarRunner = createSubprocessTarRunner();
