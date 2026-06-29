/**
 * First-party Capsule module: takosumi-ai-endpoint.
 *
 * This is a pure value-projection module for the AIEndpoint Resource Shape.
 * The actual upstream provider/gateway is selected by the Takosumi Resolver and
 * operator-managed Target/Adapter capabilities, not by this module.
 */

import type { TemplateDefinition } from "@takosumi/internal/deploy-control-api";

export const takosumiAiEndpointTemplate: TemplateDefinition = {
  id: "takosumi-ai-endpoint",
  name: "Takosumi AI Endpoint",
  version: "1.0.0",
  description:
    "Projects an AIEndpoint Resource Shape as OpenTofu-visible outputs while the Resolver selects the actual AI target.",
  source: {
    localModulePath: "/app/templates/takosumi-ai-endpoint/module",
  },
  inputs: {
    endpointName: {
      type: "string",
      title: "Endpoint name",
      required: true,
      description: "Logical AI endpoint name.",
    },
    implementation: {
      type: "string",
      title: "Implementation",
      required: true,
      description: "Resolver-selected implementation.",
    },
    targetName: {
      type: "string",
      title: "Target name",
      required: true,
      description: "Resolver-selected TargetPool entry name.",
    },
    targetType: {
      type: "string",
      title: "Target type",
      required: true,
      description: "Resolver-selected Target type.",
    },
    baseUrl: {
      type: "string",
      title: "Base URL",
      required: false,
      description:
        "Projected endpoint base URL. Empty means the selected adapter owns runtime projection.",
      default: "",
    },
    defaultModel: {
      type: "string",
      title: "Default model",
      required: false,
      description: "Optional public default model alias.",
      default: "",
    },
  },
  outputs: {
    public: {
      base_url: { type: "string", from: "base_url" },
      default_model: { type: "string", from: "default_model" },
    },
  },
  policy: {
    allowedProviders: [],
    allowedResourceTypes: [],
    destructiveChanges: { requireExplicitConfirmation: true },
  },
};
