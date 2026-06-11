import type {
  DeploymentOutput,
  OpenTofuOutputEnvelope,
  OpenTofuOutputValue,
} from "@takosumi/internal/deploy-control-api";

export interface OpenTofuOutputRecord {
  readonly sensitive?: boolean;
  readonly type?: unknown;
  readonly value: unknown;
}

export type OpenTofuOutputJson = Readonly<Record<string, OpenTofuOutputRecord>>;

export interface ExtractDeploymentOutputsOptions {
  readonly outputs: string | unknown;
  /**
   * Optional map from output name to public output kind. When omitted, only
   * well-known output names are published.
   */
  readonly outputKinds?: Readonly<Record<string, string>>;
}

const WELL_KNOWN_OUTPUT_KINDS: Readonly<Record<string, string>> = {
  launch_url: "launch_url",
  admin_url: "admin_url",
  health_url: "health_url",
  docs_url: "docs_url",
  service_url: "service_url",
  takosumi_launch_url: "launch_url",
  takosumi_admin_url: "admin_url",
  takosumi_health_url: "health_url",
  takosumi_docs_url: "docs_url",
  takosumi_service_url: "service_url",
};

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

export function extractDeploymentOutputs(
  options: ExtractDeploymentOutputsOptions,
): readonly DeploymentOutput[] {
  const outputs = parseOpenTofuOutputs(options.outputs);
  const kinds = { ...WELL_KNOWN_OUTPUT_KINDS, ...(options.outputKinds ?? {}) };
  const result: DeploymentOutput[] = [];
  for (const [name, output] of Object.entries(outputs)) {
    if (output.sensitive === true) continue;
    const kind = kinds[name];
    if (!kind) continue;
    result.push({
      name,
      kind,
      value: asJsonValue(output.value, name),
      sensitive: false,
    });
  }
  return result;
}

export function toDeployControlOutputEnvelope(
  input: OpenTofuOutputJson,
): OpenTofuOutputEnvelope {
  const envelope: Record<string, OpenTofuOutputValue> = {};
  for (const [name, output] of Object.entries(input)) {
    envelope[name] = {
      ...(typeof output.sensitive === "boolean"
        ? { sensitive: output.sensitive }
        : {}),
      ...("type" in output ? { type: asJsonValue(output.type, name) } : {}),
      value: asJsonValue(output.value, name),
    };
  }
  return envelope;
}

function asJsonValue(value: unknown, outputName: string): DeploymentOutput["value"] {
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
    const object: Record<string, DeploymentOutput["value"]> = {};
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
