import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "../schema/postgres.ts";
import type { TakosumiPostgresDrizzleDatabase } from "./types.ts";

export function createTakosumiPostgresDrizzleDatabase(
  client: Pool,
): TakosumiPostgresDrizzleDatabase {
  return {
    dialect: "postgres",
    db: drizzle({ client, schema }),
    schema,
  };
}
