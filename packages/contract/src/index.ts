export * from "./types.ts";
// app-spec.ts and installer-api.ts are intentionally omitted from this
// compatibility umbrella to avoid name collisions with legacy deploy-core
// projections (AppSpec, Deployment, etc.). Import current v1 spec DTOs via the
// explicit subpaths:
//   import { ... } from "@takos/takosumi-contract/app-spec";
//   import { ... } from "@takos/takosumi-contract/installer-api";
export * from "./core-v1.ts";
export * from "./internal-api.ts";
export {
  EnvTakosumiServiceDirectory,
  signTakosumiInternalRequest,
  TAKOSUMI_CORRELATION_ID_HEADER,
  TAKOSUMI_REQUEST_ID_HEADER,
  TAKOSUMI_TRACEPARENT_HEADER,
  TakosumiInternalClient,
  type TakosumiInternalTraceContext,
  type TakosumiInternalTraceSink,
  type TakosumiInternalTraceSpanEvent,
} from "./internal-rpc.ts";
export * from "./plugin.ts";
export * from "./plugin-sdk.ts";
export * from "./runtime-agent.ts";
export * from "./runtime-agent-lifecycle.ts";
export * from "./error-category.ts";
// Legacy connector-local shape/provider registries. Current reference
// materializers should implement KernelPlugin from ./plugin.ts directly; these
// exports remain for older provider packages and adapter bridges.
export * from "./shape.ts";
export * from "./provider-plugin.ts";
