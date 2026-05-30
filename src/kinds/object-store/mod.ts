export * from "./src/object-store.ts";
export * from "./src/object-store.generated.ts";

import { ObjectStoreKind } from "./src/object-store.ts";
import {
  OBJECT_STORE_KIND_NAME,
  OBJECT_STORE_KIND_URI,
} from "./src/object-store.generated.ts";

export const KIND_NAME = OBJECT_STORE_KIND_NAME;
export const KIND_URI = OBJECT_STORE_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
});
export const KIND_DESCRIPTOR = ObjectStoreKind;
