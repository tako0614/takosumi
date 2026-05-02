/**
 * Takos-Git source adapter — **Takos-specific optional extension**.
 *
 * Most Takosumi consumers do not need this. It exists because the Takos
 * ecosystem hosts its own Git server (`takos/git`) with its own internal
 * source-snapshot RPC, and the legacy kernel had this adapter
 * baked in. As part of the Takosumi extraction the adapter moved here so
 * generic Takosumi users never depend on Takos-specific protocols.
 *
 * Operators that run Takos opt in by:
 *
 *   1. Importing `createTakosGitSourceExtension` from
 *      `@takosumi/plugins/extensions/takos-git`.
 *   2. Constructing the extension with their `TakosInternalClient` and
 *      registering the returned `sourcePort` with the kernel under a profile
 *      that selects it for the `source` port.
 *
 * Other consumers ignore this directory entirely.
 */
export * from "./source.ts";
