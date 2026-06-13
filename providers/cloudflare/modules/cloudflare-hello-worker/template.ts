/**
 * First-party starter Capsule module: cloudflare-hello-worker.
 *
 * A runnable Cloudflare Worker with NO build step — the Worker source is baked
 * inline in `module/main.tf`, so `tofu apply` alone produces a reachable
 * workers.dev page (the `url` output). The "5 minutes to a live thing" starter.
 * Keep this object in sync with `module/main.tf`.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";

export const cloudflareHelloWorkerTemplate: TemplateDefinition = {
  id: "cloudflare-hello-worker",
  name: "Hello Worker (starter)",
  version: "1.0.0",
  description:
    "Deploys a tiny inline Cloudflare Worker (no build) that serves a page on workers.dev — install, plan, apply, open the URL.",
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
      description: "Script name; also the label in the workers.dev URL.",
    },
    accountSubdomain: {
      type: "string",
      title: "workers.dev subdomain",
      required: false,
      description:
        "The account's <this>.workers.dev label, used to render the public URL output.",
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
