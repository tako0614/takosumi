import { resolve } from "node:path";
import { loadD1AccountsMigrationCatalog } from "../../../accounts/service/src/d1-migrations.ts";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error(
    "usage: bun render-accounts-d1-migrations.ts <output-json-path>",
  );
}

const catalog = await loadD1AccountsMigrationCatalog();
const resolvedOutputPath = resolve(outputPath);
const runtimeOutputPath = resolvedOutputPath.replace(/\.json$/u, ".runtime.mjs");
if (runtimeOutputPath === resolvedOutputPath) {
  throw new Error("accounts D1 migration artifact path must end in .json");
}
const runtimeBuild = await Bun.build({
  entrypoints: [
    resolve(import.meta.dir, "../../../accounts/service/src/d1-migrations.ts"),
  ],
  format: "esm",
  target: "node",
  minify: false,
  sourcemap: "none",
});
if (!runtimeBuild.success || runtimeBuild.outputs.length !== 1) {
  throw new Error("failed to render Accounts-owned D1 migration runtime");
}
await Bun.write(runtimeOutputPath, runtimeBuild.outputs[0]!);

await Bun.write(
  resolvedOutputPath,
  `${JSON.stringify(
    {
      kind: "takosumi.accounts.local-d1-migrations@v2",
      catalogDigest: catalog.digest,
      policyDigest: catalog.policyDigest,
      headVersion: catalog.headVersion,
      migrations: catalog.migrations,
      schemaClosures: catalog.schemaClosures,
      preLedgerPolicy: catalog.preLedgerPolicy,
    },
    null,
    2,
  )}\n`,
);
