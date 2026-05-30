export * from "./src/kv-store.ts";
export * from "./src/kv-store.generated.ts";

import { KvStoreKind } from "./src/kv-store.ts";
import {
  KV_STORE_KIND_NAME,
  KV_STORE_KIND_URI,
} from "./src/kv-store.generated.ts";

export const KIND_NAME = KV_STORE_KIND_NAME;
export const KIND_URI = KV_STORE_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
  "kv": KIND_URI,
});
export const KIND_DESCRIPTOR = KvStoreKind;
