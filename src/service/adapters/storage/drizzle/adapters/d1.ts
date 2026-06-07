import { drizzle } from "drizzle-orm/d1";
import * as schema from "../schema/d1.ts";
import type { TakosumiD1DrizzleDatabase } from "./types.ts";

export interface DrizzleD1Database {
  prepare(query: string): unknown;
  batch?(statements: readonly unknown[]): Promise<readonly unknown[]>;
}

export function createTakosumiD1DrizzleDatabase(
  binding: DrizzleD1Database,
): TakosumiD1DrizzleDatabase {
  return {
    dialect: "d1",
    db: drizzle(binding, { schema }),
    schema,
  };
}
