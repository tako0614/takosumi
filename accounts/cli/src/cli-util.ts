export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function materializeApprovalDigest(input: {
  installationId: string;
  mode: "dedicated";
  region: string;
  plan: Record<string, unknown>;
  cutover: Record<string, unknown>;
}): Promise<string> {
  return `sha256:${await sha256Hex(
    canonicalJson({
      operation: "materialize",
      installationId: input.installationId,
      mode: input.mode,
      region: input.region,
      plan: input.plan,
      cutover: input.cutover,
    }),
  )}`;
}

export function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function actorIdentityValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function stringArrayValue(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TypeError(`${label} must contain non-empty strings`);
    }
    output.push(entry);
  }
  return output;
}

export function optionalStringRecord(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new TypeError(`${label}.${key} must be a non-empty string`);
    }
    output[key] = entry;
  }
  return output;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Takosumi Accounts returned invalid JSON");
  }
}

export function accountsApiErrorMessage(
  value: unknown,
  fallback: string,
): string {
  if (!isRecord(value)) return fallback;
  return (
    stringValue(value.error_description) ??
    stringValue(value.message) ??
    stringValue(value.error) ??
    fallback
  );
}
