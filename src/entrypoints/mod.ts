export * from "../contract/mod.ts";
// The umbrella entry surfaces the embeddable framework so operator distributions
// (e.g. takosumi) can `import { createTakosumiService } from "@takosjp/takosumi"`.
// `createTakosumiService` returns the service Hono `app` + operate facade; the framework
// never self-serves, so the composer owns serving and route extension.
export {
  createTakosumiService,
  defaultBundledImplementations,
  registerDefaultArtifactKinds,
} from "../service/bootstrap.ts";
export type {
  CreatedTakosumiService,
  CreateTakosumiServiceOptions,
  TakosumiOperations,
} from "../service/bootstrap.ts";
