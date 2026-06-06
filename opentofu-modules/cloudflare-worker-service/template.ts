/**
 * Official template: cloudflare-worker-service.
 *
 * Deploys a module-syntax Cloudflare Worker (Hono or any bundled module) from a
 * build artifact. Authored as TypeScript catalog data; the `module/` directory
 * is the OpenTofu surface baked into the runner image. Keep this object in sync
 * with `module/main.tf`.
 */

import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";

export const cloudflareWorkerServiceTemplate: TemplateDefinition = {
  id: "cloudflare-worker-service",
  name: "Cloudflare Worker Service",
  version: "1.0.0",
  description:
    "Builds a Bun project and deploys the bundled module to a Cloudflare Worker, optionally on workers.dev.",
  source: {
    localModulePath: "/app/templates/cloudflare-worker-service/module",
  },
  build: {
    runtime: "bun",
    commands: ["bun install --frozen-lockfile", "bun run build"],
    artifactPath: "dist/index.js",
  },
  inputs: {
    appName: {
      type: "string",
      title: "Worker name",
      required: true,
      description: "Script name; also the workers.dev subdomain label.",
    },
    accountId: {
      type: "string",
      title: "Cloudflare account id",
      required: true,
      description: "Account that will own the Worker.",
    },
  },
  outputs: {
    public: {
      worker_name: { type: "string", from: "worker_name" },
      url: { type: "string", from: "url" },
    },
  },
  policy: {
    allowedProviders: ["cloudflare/cloudflare"],
    allowedResourceTypes: [
      "cloudflare_workers_script",
      "cloudflare_workers_script_subdomain",
    ],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};
