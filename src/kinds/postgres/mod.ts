export * from "./src/database-postgres.ts";
export * from "./src/database-postgres.generated.ts";

import { DatabasePostgresKind } from "./src/database-postgres.ts";
import {
  DATABASE_POSTGRES_KIND_NAME,
  DATABASE_POSTGRES_KIND_URI,
} from "./src/database-postgres.generated.ts";

export const KIND_NAME = DATABASE_POSTGRES_KIND_NAME;
export const KIND_URI = DATABASE_POSTGRES_KIND_URI;
export const KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [KIND_NAME]: KIND_URI,
});
export const KIND_DESCRIPTOR = DatabasePostgresKind;
