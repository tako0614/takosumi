export * from "./src/vector-store.ts";
export * from "./src/vector-store.generated.ts";

import { VectorStoreKind } from "./src/vector-store.ts";
import {
  VECTOR_STORE_KIND_NAME,
  VECTOR_STORE_KIND_URI,
} from "./src/vector-store.generated.ts";

export const KIND_NAME = VECTOR_STORE_KIND_NAME;
export const KIND_URI = VECTOR_STORE_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
});
export const KIND_DESCRIPTOR = VectorStoreKind;
