/**
 * First-party starter Capsule module: cloudflare-hello-worker.
 *
 * A runnable Cloudflare Worker with NO build step — the Worker source is baked
 * inline in `module/main.tf`, so `tofu apply` creates a real Worker script and
 * enables its workers.dev URL.
 * Keep this object in sync with `module/main.tf`.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";

export const cloudflareHelloWorkerTemplate: TemplateDefinition = {
  id: "cloudflare-hello-worker",
  name: "Hello Worker (starter)",
  version: "1.0.0",
  description:
    "Deploys a tiny inline Cloudflare Worker (no build) and enables a workers.dev URL.",
  source: {
    localModulePath: "/app/templates/cloudflare-hello-worker/module",
  },
  inputs: {
    accountId: {
      type: "string",
      title: "Cloudflare account id",
      required: true,
      description: "Account that will own the Worker.",
    },
    appName: {
      type: "string",
      title: "Worker name",
      required: false,
      description: "Script name.",
    },
    workersSubdomain: {
      type: "string",
      title: "Workers subdomain",
      required: true,
      description:
        "The Cloudflare Workers subdomain for the account, without .workers.dev.",
    },
  },
  outputs: {
    public: {
      worker_name: { type: "string", from: "worker_name" },
      url: { type: "url", from: "url" },
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
