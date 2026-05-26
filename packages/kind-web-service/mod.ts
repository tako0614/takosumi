export * from "./src/web-service.ts";
export * from "./src/web-service.generated.ts";

import { WebServiceKind } from "./src/web-service.ts";
import {
  WEB_SERVICE_KIND_NAME,
  WEB_SERVICE_KIND_URI,
} from "./src/web-service.generated.ts";

export const KIND_NAME = WEB_SERVICE_KIND_NAME;
export const KIND_URI = WEB_SERVICE_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
});
export const KIND_DESCRIPTOR = WebServiceKind;
