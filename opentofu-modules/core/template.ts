/**
 * First-party Capsule module: core.
 *
 * The base Installation under a Space (spec §5/§10). Authored as TypeScript
 * catalog data (the service cannot read the filesystem in Workers). The
 * `module/` directory next to this file is the human-readable OpenTofu surface
 * and is baked into the runner image at `source.localModulePath`. Keep this
 * object in sync with `module/main.tf`.
 *
 * For the MVP this is a pure value-plumbing module: no providers, no cloud
 * resources, just origin derivation from `base_domain`.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";

export const coreTemplate: TemplateDefinition = {
  id: "core",
  name: "Takos Core (base installation)",
  version: "1.0.0",
  description:
    "Base installation under a Space: derives generic service origins from a base domain. No cloud resources.",
  source: {
    localModulePath: "/app/templates/core/module",
  },
  inputs: {
    base_domain: {
      type: "string",
      title: "Base domain",
      required: true,
      description:
        "Base domain for this installation (e.g. example.com). Drives every derived origin.",
    },
    display_name: {
      type: "string",
      title: "Display name",
      required: false,
      description: "Optional human-readable name for the installation.",
      default: "",
    },
  },
  outputs: {
    public: {
      base_domain: { type: "string", from: "base_domain" },
      public_origin: { type: "string", from: "public_origin" },
      member_issuer: { type: "string", from: "member_issuer" },
      service_registry_url: { type: "string", from: "service_registry_url" },
    },
  },
  policy: {
    allowedProviders: [],
    allowedResourceTypes: [],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};
