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
  capsuleId: string;
  mode: "dedicated";
  region: string;
  plan: Record<string, unknown>;
  cutover: Record<string, unknown>;
}): Promise<string> {
  return `sha256:${await sha256Hex(
    canonicalJson({
      operation: "materialize",
      capsuleId: input.capsuleId,
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
  const nestedError = isRecord(value.error) ? value.error : undefined;
  return (
    stringValue(value.error_description) ??
    stringValue(value.message) ??
    stringValue(nestedError?.message) ??
    stringValue(value.error) ??
    fallback
  );
}
