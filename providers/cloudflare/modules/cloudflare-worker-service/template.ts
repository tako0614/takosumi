/**
 * Legacy Capsule module: cloudflare-worker-service.
 *
 * Legacy first-party example for deploying a module-syntax Cloudflare Worker
 * from a runner-produced JS file. The active Takosumi install model is Git
 * OpenTofu execution; new generated-root dispatch does not run this build path.
 * Keep this object in sync with `module/main.tf` for stored row readability.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";

export const cloudflareWorkerServiceTemplate: TemplateDefinition = {
  id: "cloudflare-worker-service",
  name: "Cloudflare Worker Service",
  version: "1.0.0",
  description:
    "Legacy example that deploys a bundled module to a Cloudflare Worker script.",
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
      description: "Script name.",
    },
    accountId: {
      type: "string",
      title: "Cloudflare account id",
      required: true,
      description: "Account that will own the Worker.",
    },
    publicUrl: {
      type: "string",
      title: "Public URL",
      required: false,
      description:
        "Optional URL projected by dispatcher/custom-route configuration after apply.",
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
    allowedResourceTypes: ["cloudflare_workers_script"],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};
