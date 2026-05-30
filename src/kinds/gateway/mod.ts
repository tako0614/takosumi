export * from "./src/gateway.ts";
export * from "./src/gateway.generated.ts";

import { GatewayKind } from "./src/gateway.ts";
import {
  GATEWAY_KIND_NAME,
  GATEWAY_KIND_URI,
} from "./src/gateway.generated.ts";

export const KIND_NAME = GATEWAY_KIND_NAME;
export const KIND_URI = GATEWAY_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
});
export const KIND_DESCRIPTOR = GatewayKind;
