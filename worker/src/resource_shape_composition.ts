import {
  isBundledResourceShapeKind,
  isResourceShapeKind,
  type ResourceShapeKind,
} from "takosumi-contract";
import type {
  ResourceShapeModuleRegistry,
  ResourceShapeSchemaRegistry,
} from "../../core/domains/resource-shape/mod.ts";

/**
 * Code-installed Resource Shape contributions carried by a host Worker
 * composition. These are deliberately runtime objects, not string vars or
 * OpenTofu outputs: schema and module execution authority must come from code
 * the operator installed and reviewed.
 */
export interface ResourceShapeCompositionBindings {
  readonly TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY?: ResourceShapeSchemaRegistry;
  readonly TAKOSUMI_RESOURCE_SHAPE_MODULE_REGISTRY?: ResourceShapeModuleRegistry;
}

export interface ResourceShapeHostContributions {
  readonly schemaRegistry?: ResourceShapeSchemaRegistry;
  readonly moduleRegistry?: ResourceShapeModuleRegistry;
}

export function resourceShapeHostContributionsFromEnv(
  env: ResourceShapeCompositionBindings,
): ResourceShapeHostContributions {
  const schemaRegistry = validateSchemaRegistry(
    env.TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY,
  );
  const moduleRegistry = validateModuleRegistry(
    env.TAKOSUMI_RESOURCE_SHAPE_MODULE_REGISTRY,
  );
  return {
    ...(schemaRegistry ? { schemaRegistry } : {}),
    ...(moduleRegistry ? { moduleRegistry } : {}),
  };
}

/**
 * Resolves the operator allowlist against the schemas actually installed in
 * this host. Unknown but syntactically valid tokens fail configuration rather
 * than being advertised without validation/execution authority.
 */
export function configuredResourceShapeKinds(
  value: unknown,
  schemaRegistry?: ResourceShapeSchemaRegistry,
): readonly ResourceShapeKind[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new TypeError("TAKOSUMI_RESOURCE_SHAPES must be a string");
  }
  const raw = value.trim();
  if (!raw) return [];

  const registeredKinds = validateSchemaRegistry(schemaRegistry)?.kinds() ?? [];
  const available = [...registeredKinds];
  const tokens = raw === "all" ? available : parseConfiguredTokens(raw);
  const out: ResourceShapeKind[] = [];
  const seen = new Set<ResourceShapeKind>();

  for (const token of tokens) {
    if (!isResourceShapeKind(token)) {
      throw new TypeError(
        `TAKOSUMI_RESOURCE_SHAPES contains invalid kind token: ${token}`,
      );
    }
    if (!registeredKinds.includes(token)) {
      throw new TypeError(
        `TAKOSUMI_RESOURCE_SHAPES kind ${token} has no installed schema`,
      );
    }
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function validateSchemaRegistry(
  value: ResourceShapeSchemaRegistry | undefined,
): ResourceShapeSchemaRegistry | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.get !== "function" ||
    typeof value.kinds !== "function"
  ) {
    throw new TypeError(
      "TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY must implement get() and kinds()",
    );
  }
  const kinds = value.kinds();
  if (!Array.isArray(kinds)) {
    throw new TypeError(
      "TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY.kinds() must return an array",
    );
  }
  for (const kind of kinds) {
    if (!isResourceShapeKind(kind)) {
      throw new TypeError(
        `invalid operator-defined Resource Shape schema token: ${String(kind)}`,
      );
    }
    if (!isBundledResourceShapeKind(kind) && typeof value.get(kind) !== "function") {
      throw new TypeError(
        `Resource Shape schema registry has no parser for ${kind}`,
      );
    }
  }
  return value;
}

function validateModuleRegistry(
  value: ResourceShapeModuleRegistry | undefined,
): ResourceShapeModuleRegistry | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.get !== "function"
  ) {
    throw new TypeError(
      "TAKOSUMI_RESOURCE_SHAPE_MODULE_REGISTRY must implement get()",
    );
  }
  return value;
}

function parseConfiguredTokens(raw: string): readonly string[] {
  if (raw.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new TypeError("TAKOSUMI_RESOURCE_SHAPES must be valid JSON", {
        cause: error,
      });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new TypeError(
        "TAKOSUMI_RESOURCE_SHAPES JSON value must be a string array",
      );
    }
    return parsed;
  }
  return raw
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
