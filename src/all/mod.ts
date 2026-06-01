export * from "../contract/mod.ts";
// The umbrella entry surfaces the embeddable framework so operator distributions
// (e.g. takosumi) can `import { createPaaSApp } from "@takosjp/takosumi"`.
// `createPaaSApp` returns the kernel Hono `app` + operate facade; the framework
// never self-serves, so the composer owns serving and route extension.
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
