import type { deployControlD1Schema, deployControlPostgresSchema } from "../schema/index.ts";

export type TakosumiDrizzleDialect = "d1" | "postgres";

export interface TakosumiD1DrizzleDatabase {
  readonly dialect: "d1";
  readonly db: unknown;
  readonly schema: typeof deployControlD1Schema;
}

export interface TakosumiPostgresDrizzleDatabase {
  readonly dialect: "postgres";
  readonly db: unknown;
  readonly schema: typeof deployControlPostgresSchema;
}

export type TakosumiDrizzleDatabase =
  | TakosumiD1DrizzleDatabase
  | TakosumiPostgresDrizzleDatabase;
