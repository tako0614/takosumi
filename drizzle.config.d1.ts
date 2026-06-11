import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./core/adapters/storage/drizzle/schema/d1.ts",
  out: "./core/adapters/storage/drizzle/migrations/d1",
});
