// Reference compatibility umbrella for Takosumi implementation packages.
//
// The package root exposes the current AppSpec / Installer API wire contract.
// This entry point exposes the larger reference implementation API used by
// kernel, runtime-agent, provider, and connector packages while deploy-core
// compatibility types are being retired.

export * from "./types.ts";
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
export * from "./shape.ts";
