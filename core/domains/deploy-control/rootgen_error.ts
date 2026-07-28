import { RootgenValidationError } from "takosumi-rootgen";

import { OpenTofuControllerError } from "./errors.ts";

/**
 * Translate the leaf rootgen library's validation vocabulary at the Core
 * boundary. Unknown failures retain their identity and remain internal errors.
 */
export function rootgenErrorForController(error: unknown): unknown {
  if (!(error instanceof RootgenValidationError)) return error;
  return new OpenTofuControllerError(error.code, error.message, error.details);
}
