/**
 * Official template: cloudflare-static-site.
 *
 * Provisions a Cloudflare Pages project that serves a static site. Authored as
 * TypeScript catalog data (the service cannot read the filesystem in Workers).
 * The `module/` directory next to this file is the human-readable OpenTofu
 * surface and is baked into the runner image at `source.localModulePath`. Keep
 * this object in sync with `module/main.tf`.
 */

import type { TemplateDefinition } from "takosumi-contract/deploy-control-api";

export const cloudflareStaticSiteTemplate: TemplateDefinition = {
  id: "cloudflare-static-site",
  name: "Cloudflare Static Site",
  version: "1.0.0",
  description:
    "Provisions a Cloudflare Pages project that serves a static site.",
  source: {
    localModulePath: "/app/templates/cloudflare-static-site/module",
  },
  inputs: {
    projectName: {
      type: "string",
      title: "Project name",
      required: true,
      description:
        "Cloudflare Pages project name (also the *.pages.dev subdomain label).",
    },
    accountId: {
      type: "string",
      title: "Cloudflare account id",
      required: true,
      description: "Account that will own the Pages project.",
    },
    productionBranch: {
      type: "string",
      title: "Production branch",
      required: false,
      description: "Git branch that maps to the production deployment.",
      default: "main",
    },
  },
  outputs: {
    public: {
      project_name: { type: "string", from: "project_name" },
      url: { type: "string", from: "url" },
    },
  },
  policy: {
    allowedProviders: ["cloudflare/cloudflare"],
    allowedResourceTypes: ["cloudflare_pages_project"],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};
