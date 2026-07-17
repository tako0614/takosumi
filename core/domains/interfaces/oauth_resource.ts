import type { Interface } from "takosumi-contract/interfaces";

/**
 * Canonical OAuth resource identity shared by Core validation and durable
 * Interface-store authority claims. Query strings and fragments identify a
 * request/client view, not a distinct RFC 8707 resource server.
 */
export function canonicalInterfaceOAuth2ResourceUri(
  value: unknown,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 2_048
  ) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    urlParametersContainCredential(parsed.searchParams) ||
    (parsed.hash.length > 1 &&
      urlParametersContainCredential(
        new URLSearchParams(parsed.hash.slice(1)),
      ))
  ) {
    return undefined;
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

/** Exact claimable resource for a currently Resolved Interface. */
export function interfaceOAuth2ResourceUri(
  iface: Interface,
): string | undefined {
  if (iface.status.phase !== "Resolved") return undefined;
  const inputName = iface.spec.access.resourceUriInput;
  if (!inputName) return undefined;
  return canonicalInterfaceOAuth2ResourceUri(
    iface.status.resolvedInputs?.[inputName],
  );
}

const SECRET_URL_PARAMETER_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "token",
  "clientsecret",
  "privatekey",
  "signingkey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearertoken",
  "credential",
  "credentials",
  "credentialvalue",
  "xapikey",
  "auth",
  "jwt",
  "session",
  "sessionid",
  "sig",
  "signature",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

function urlParametersContainCredential(parameters: URLSearchParams): boolean {
  for (const [name, value] of parameters) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (value.trim() !== "" && SECRET_URL_PARAMETER_NAMES.has(normalizedName)) {
      return true;
    }
  }
  return false;
}
