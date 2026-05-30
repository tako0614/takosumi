// `@takosjp/takosumi/kernel` surfaces the FRAMEWORK: `createPaaSApp` (the
// embeddable Hono app factory + operate facade). It lives in the kernel
// bootstrap module, which is now the kernel package's `.` entry (flipped from
// the old self-serving `src/index.ts`). The self-serving server runner
// (`startKernel` + the `import.meta.main` boot) lives behind the explicit
// `@takosjp/takosumi/server` entry — never reached on a framework import.
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
