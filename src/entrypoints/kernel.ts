// `@takosjp/takosumi/kernel` surfaces the embeddable framework:
// `createPaaSApp` returns the Hono app plus the operate facade. The
// self-serving dev runner (`startKernel` + `import.meta.main`) stays behind
// the explicit `@takosjp/takosumi/server` entry.
export {
  createPaaSApp,
  defaultBundledPlugins,
  registerDefaultArtifactKinds,
} from "../kernel/bootstrap.ts";
export type {
  CreatedPaaSApp,
  CreatePaaSAppOptions,
  TakosumiKernelFacade,
} from "../kernel/bootstrap.ts";
