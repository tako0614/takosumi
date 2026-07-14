import { MapResourceShapeModuleRegistry } from "../../../core/domains/resource-shape/planner.ts";

const MODULE_IDS = [
  "cloudflare-worker-service",
  "cloudflare-r2-bucket",
  "cloudflare-kv-store",
  "cloudflare-queue",
  "cloudflare-sql-database",
  "cloudflare-container-service",
] as const;

/** Explicit test/operator injection; production Core has no default registry. */
export const TEST_RESOURCE_SHAPE_MODULE_REGISTRY =
  new MapResourceShapeModuleRegistry(
    Object.fromEntries(
      MODULE_IDS.map((id) => [
        id,
        {
          files: [
            {
              path: "main.tf",
              text: `# operator test module: ${id}\nterraform {}\n`,
            },
          ],
        },
      ]),
    ),
  );
