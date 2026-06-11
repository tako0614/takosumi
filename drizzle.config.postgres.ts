import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./core/adapters/storage/drizzle/schema/postgres.ts",
  out: "./core/adapters/storage/drizzle/migrations/postgres",
});
