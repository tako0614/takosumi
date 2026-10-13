import { OpenTofuControllerError } from "../deploy-control/errors.ts";

/** Only an exact, single explicit opt-in may select the immediate Plan path. */
export function capsuleDeleteIsImmediate(url: URL): boolean {
  const values = url.searchParams.getAll("immediate");
  if (values.length === 0) return false;
  if (values.length === 1 && values[0] === "false") return false;
  if (values.length === 1 && values[0] === "true") return true;
  throw new OpenTofuControllerError(
    "invalid_argument",
    "immediate must be a single true or false query parameter",
  );
}
