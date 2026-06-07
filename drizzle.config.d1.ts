import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/service/adapters/storage/drizzle/schema/d1.ts",
  out: "./src/service/adapters/storage/drizzle/migrations/d1",
});
