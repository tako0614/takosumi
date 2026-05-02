import { LocalOperatorConfig } from "./local.ts";
import type {
  LocalOperatorConfigInputValue,
  OperatorConfigPort,
  OperatorConfigSecretRef,
} from "./types.ts";

export interface EnvOperatorConfigOptions {
  readonly env?: Record<string, string | undefined>;
  readonly include?: readonly string[];
  readonly secretRefKeys?: readonly string[];
  readonly clock?: () => Date;
}

export class EnvOperatorConfig extends LocalOperatorConfig
  implements OperatorConfigPort {
  constructor(options: EnvOperatorConfigOptions = {}) {
    super({
      values: readEnvValues(options),
      source: "env",
      clock: options.clock,
    });
  }
}

function readEnvValues(
  options: EnvOperatorConfigOptions,
): Record<string, LocalOperatorConfigInputValue> {
  const env = options.env ?? Deno.env.toObject();
  const include = options.include ?? Object.keys(env).sort();
  const secretRefKeys = new Set(options.secretRefKeys ?? []);
  const values: Record<string, LocalOperatorConfigInputValue> = {};

  for (const key of include) {
    const raw = env[key];
    if (raw === undefined) continue;
    values[key] = secretRefKeys.has(key) || isSecretRefKey(key)
      ? parseSecretRef(raw)
      : raw;
  }

  return values;
}

export function isSecretRefKey(key: string): boolean {
  return key.endsWith("_SECRET_REF") || key.endsWith("_SECRET_VERSION_REF");
}

export function parseSecretRef(raw: string): OperatorConfigSecretRef {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("operator config secret ref must not be empty");
  }

  const at = trimmed.lastIndexOf("@");
  if (at > 0 && at < trimmed.length - 1) {
    return Object.freeze({
      name: trimmed.slice(0, at),
      version: trimmed.slice(at + 1),
    });
  }

  return Object.freeze({ name: trimmed });
}
