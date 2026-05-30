export * from "./src/sqlite.ts";
export * from "./src/sqlite.generated.ts";

import { SqliteKind } from "./src/sqlite.ts";
import { SQLITE_KIND_NAME, SQLITE_KIND_URI } from "./src/sqlite.generated.ts";

export const KIND_NAME = SQLITE_KIND_NAME;
export const KIND_URI = SQLITE_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
});
export const KIND_DESCRIPTOR = SqliteKind;
