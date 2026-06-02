import type { PlatformService } from "@takosjp/takosumi/contract/installer-api";

type PlatformServiceMaterial = NonNullable<PlatformService["material"]>;
type PlatformServiceMaterialValue = PlatformServiceMaterial[string];

export interface OpenTofuOutputRecord {
  readonly sensitive?: boolean;
  readonly type?: unknown;
  readonly value: unknown;
}

export type OpenTofuOutputJson = Readonly<Record<string, OpenTofuOutputRecord>>;

export interface OpenTofuPlatformServiceDefinition {
  readonly spaceId?: string;
  readonly spaceIds?: readonly string[];
  readonly path?: string;
  readonly kind: string;
  readonly name?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly material?: Readonly<Record<string, string>>;
}

export interface OpenTofuPlatformServiceBindingSelection {
  readonly servicePath?: string;
  readonly serviceKind?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface OpenTofuPlatformServiceResolveContext {
  readonly spaceId?: string;
  readonly binding: OpenTofuPlatformServiceBindingSelection;
}

export interface OpenTofuPlatformServiceResolver {
  resolve(
    context: OpenTofuPlatformServiceResolveContext,
  ): readonly PlatformService[] | undefined;
}

export interface CreateOpenTofuPlatformServiceResolverOptions {
  readonly outputs: string | unknown;
  readonly services: readonly OpenTofuPlatformServiceDefinition[];
  readonly includeSensitiveOutputs?: boolean;
}

export function parseOpenTofuOutputs(input: string | unknown): OpenTofuOutputJson {
  const parsed = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (!isRecord(parsed)) {
    throw new TypeError("OpenTofu output JSON must be an object");
  }

  const outputs: Record<string, OpenTofuOutputRecord> = {};
  for (const [name, record] of Object.entries(parsed)) {
    if (!isRecord(record) || !("value" in record)) {
      throw new TypeError(
        `OpenTofu output ${name} must be an object with a value field`,
      );
    }
    outputs[name] = {
      ...(typeof record.sensitive === "boolean"
        ? { sensitive: record.sensitive }
        : {}),
      ...("type" in record ? { type: record.type } : {}),
      value: record.value,
    };
  }
  return outputs;
}

export function createOpenTofuPlatformServiceResolver(
  options: CreateOpenTofuPlatformServiceResolverOptions,
): OpenTofuPlatformServiceResolver {
  const outputs = parseOpenTofuOutputs(options.outputs);
  const services = options.services.map((definition) => ({
    definition,
    service: materializePlatformService(definition, outputs, {
      includeSensitiveOutputs: options.includeSensitiveOutputs === true,
    }),
  }));

  return {
    resolve(context) {
      const matches = services
        .filter(({ definition, service }) =>
          matchesSpaceScope(definition, context.spaceId) &&
          matchesBindingSelection(service, context.binding)
        )
        .map(({ service }) => service);
      return matches.length > 0 ? matches : undefined;
    },
  };
}

function materializePlatformService(
  definition: OpenTofuPlatformServiceDefinition,
  outputs: OpenTofuOutputJson,
  options: { readonly includeSensitiveOutputs: boolean },
): PlatformService {
  const material: Record<string, PlatformServiceMaterialValue> = {};
  for (const [materialKey, outputName] of Object.entries(
    definition.material ?? {},
  )) {
    const output = outputs[outputName];
    if (!output) {
      throw new Error(`OpenTofu output ${outputName} is not available`);
    }
    if (output.sensitive === true && !options.includeSensitiveOutputs) {
      continue;
    }
    material[materialKey] = asJsonValue(output.value, outputName);
  }

  return {
    ...(definition.path ? { path: definition.path } : {}),
    kind: definition.kind,
    ...(definition.name ? { name: definition.name } : {}),
    ...(definition.labels ? { labels: definition.labels } : {}),
    ...(Object.keys(material).length > 0 ? { material } : {}),
  };
}

function matchesBindingSelection(
  service: PlatformService,
  selection: OpenTofuPlatformServiceBindingSelection,
): boolean {
  const hasSelector = Boolean(selection.servicePath || selection.serviceKind) ||
    Object.keys(selection.labels ?? {}).length > 0;
  if (!hasSelector) {
    return false;
  }
  if (selection.servicePath && service.path !== selection.servicePath) {
    return false;
  }
  if (selection.serviceKind && service.kind !== selection.serviceKind) {
    return false;
  }
  for (const [key, value] of Object.entries(selection.labels ?? {})) {
    if (service.labels?.[key] !== value) {
      return false;
    }
  }
  return true;
}

function matchesSpaceScope(
  definition: OpenTofuPlatformServiceDefinition,
  spaceId: string | undefined,
): boolean {
  if (definition.spaceId && definition.spaceIds) {
    throw new TypeError(
      "OpenTofu PlatformService definition must use spaceId or spaceIds, not both",
    );
  }
  const allowed = definition.spaceId
    ? [definition.spaceId]
    : definition.spaceIds;
  if (!allowed) return true;
  if (allowed.length === 0) {
    throw new TypeError(
      "OpenTofu PlatformService definition spaceIds must not be empty",
    );
  }
  return spaceId !== undefined && allowed.includes(spaceId);
}

function asJsonValue(value: unknown, outputName: string): PlatformServiceMaterialValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`OpenTofu output ${outputName} is not JSON-safe`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => asJsonValue(item, outputName));
  }
  if (isRecord(value)) {
    const object: Record<string, PlatformServiceMaterialValue> = {};
    for (const [key, item] of Object.entries(value)) {
      object[key] = asJsonValue(item, outputName);
    }
    return object;
  }
  throw new TypeError(`OpenTofu output ${outputName} is not JSON-safe`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
