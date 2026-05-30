export * from "@takos/takosumi-kernel";
// `createPaaSApp` (the embeddable Hono app factory + operate facade) lives in
// the kernel bootstrap module, which is reached through the kernel package's
// `./bootstrap` subpath export rather than its `.` (`src/index.ts`) entry.
// Re-export it here so framework consumers reach it via `@takosjp/takosumi/kernel`.
export {
  createPaaSApp,
  defaultBundledPlugins,
  registerDefaultArtifactKinds,
} from "@takos/takosumi-kernel/bootstrap";
export type {
  CreatedPaaSApp,
  CreatePaaSAppOptions,
  TakosumiKernelFacade,
} from "@takos/takosumi-kernel/bootstrap";
