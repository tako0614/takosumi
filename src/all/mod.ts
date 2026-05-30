export * from "@takos/takosumi-contract";
// The umbrella entry surfaces the embeddable framework so operator distributions
// (e.g. takosumi-cloud) can `import { createPaaSApp } from "@takosjp/takosumi"`.
// `createPaaSApp` returns the kernel Hono `app` + operate facade; the framework
// never self-serves, so the composer owns serving and route extension.
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
