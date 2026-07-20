import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const bundlePath = resolve(
  process.argv[2] ?? "/tmp/takosumi-platform-worker-check.mjs",
);
const bundle = await readFile(bundlePath, "utf8");

for (const forbidden of [
  "ajv/dist/",
  "node_modules/.bun/ajv@",
  "compileSchema",
  "SchemaEnv",
] as const) {
  if (bundle.includes(forbidden)) {
    throw new Error(
      `Cloudflare Worker bundle contains forbidden Ajv compiler/runtime marker ${forbidden}`,
    );
  }
}

for (const expected of [
  "schema_validators.generated.ts",
  "draft_2020_schema.generated.ts",
  "@cfworker/json-schema",
] as const) {
  if (!bundle.includes(expected)) {
    throw new Error(
      `Cloudflare Worker bundle is missing expected schema runtime marker ${expected}`,
    );
  }
}

console.log(
  `Cloudflare Worker schema bundle check passed (${bundle.length} bytes; no Ajv runtime/compiler).`,
);
