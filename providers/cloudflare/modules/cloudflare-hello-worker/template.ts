/**
 * First-party starter Capsule module: cloudflare-hello-worker.
 *
 * A runnable Cloudflare Worker with NO build step — the Worker source is baked
 * inline in `module/main.tf`, so `tofu apply` creates a real Worker script.
 * Public ingress is projected by the dispatcher/custom-route layer, not by this
 * module.
 * Keep this object in sync with `module/main.tf`.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";

export const cloudflareHelloWorkerTemplate: TemplateDefinition = {
  id: "cloudflare-hello-worker",
  name: "Hello Worker (starter)",
  version: "1.0.0",
  description:
    "Deploys a tiny inline Cloudflare Worker (no build). It reports the Worker name and accepts an optional projected public URL.",
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
