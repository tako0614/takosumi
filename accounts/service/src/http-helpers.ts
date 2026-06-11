import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AppInstallationStatus } from "./ledger.ts";

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function methodNotAllowed(allow: string): Response {
  return json({ error: "method_not_allowed" }, 405, { allow });
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function takosumiSubjectValue(
  value: unknown,
): TakosumiSubject | undefined {
  return typeof value === "string" && value.startsWith("tsub_")
    ? value as TakosumiSubject
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function stringArrayValue(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    output.push(entry);
  }
  return output;
}

export function base64UrlBytesValue(
  value: unknown,
): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== "string") return undefined;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    const binary = atob(padded);
    const output = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      output[index] = binary.charCodeAt(index);
    }
    return output;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

export function bearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function bearerChallenge(error: string): Response {
  return json({ error }, 401, {
    "www-authenticate": `Bearer error="${error}"`,
  });
}

export function appInstallationStatusValue(
  value: unknown,
): AppInstallationStatus | undefined {
  return value === "installing" ||
      value === "ready" ||
      value === "failed" ||
      value === "suspended" ||
      value === "exported"
    ? value
    : undefined;
}
