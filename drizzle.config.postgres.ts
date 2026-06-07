import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/service/adapters/storage/drizzle/schema/postgres.ts",
  out: "./src/service/adapters/storage/drizzle/migrations/postgres",
});
