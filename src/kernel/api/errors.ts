import type { Context, Hono as HonoApp } from "hono";
import { DomainError, type DomainErrorCode } from "../shared/errors.ts";

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export class MalformedJsonRequestError extends Error {
  constructor() {
    super("Malformed JSON request body");
    this.name = "MalformedJsonRequestError";
  }
}

export function apiError(
  code: string,
  message: string,
  details?: unknown,
): ApiErrorEnvelope {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

export function registerApiErrorHandler(app: HonoApp): void {
  const maybeApp = app as HonoApp & {
    onError?: HonoApp["onError"];
  };
  maybeApp.onError?.((error, c) => apiExceptionResponse(c, error));
}

export function apiExceptionResponse(c: Context, error: unknown): Response {
  if (error instanceof MalformedJsonRequestError) {
    return c.json(apiError("invalid_json", error.message), 400);
  }
  if (error instanceof DomainError) {
    return c.json(
      apiError(error.code, error.message, error.details),
      httpStatusForDomainErrorCode(error.code),
    );
  }
  return c.json(
    apiError("internal_error", "Internal server error"),
    500,
  );
}

function httpStatusForDomainErrorCode(
  code: DomainErrorCode,
): 400 | 403 | 404 | 409 | 501 {
  switch (code) {
    case "invalid_argument":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "permission_denied":
      return 403;
    case "not_implemented":
      return 501;
  }
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const rawBody = await request.text();
  if (rawBody.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new MalformedJsonRequestError();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
