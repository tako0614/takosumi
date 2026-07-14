import { isRecord, stringValue } from "./cli-util.ts";

export function formatAccountsTokensList(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  const tokens =
    isRecord(response) && Array.isArray(response.tokens) ? response.tokens : [];
  if (tokens.length === 0) return "No personal access tokens found.";
  const lines = ["Personal access tokens:"];
  for (const value of tokens) {
    if (!isRecord(value)) continue;
    const revoked = stringValue(value.revoked_at);
    const state = revoked ? "revoked" : "active";
    const scopes = Array.isArray(value.scopes)
      ? value.scopes.filter((scope) => typeof scope === "string").join(",")
      : "unknown-scopes";
    lines.push(
      `  ${stringValue(value.id) ?? "unknown"}  ${
        stringValue(value.name) ?? "unnamed"
      }  ${state}  ${scopes}`,
    );
  }
  lines.push(`${tokens.length} token(s)`);
  return lines.join("\n");
}

export function formatAccountsTokenCreate(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response) || !isRecord(response.token_record)) {
    return "Token create response is missing token details.";
  }
  const record = response.token_record;
  const scopes = Array.isArray(record.scopes)
    ? record.scopes.filter((scope) => typeof scope === "string").join(",")
    : "unknown-scopes";
  return [
    `Personal access token ${stringValue(record.id) ?? "unknown"} created`,
    `  name: ${stringValue(record.name) ?? "unnamed"}`,
    `  scopes: ${scopes}`,
    `  token: ${stringValue(response.token) ?? "missing"}`,
  ].join("\n");
}

export function formatAccountsTokenRevoke(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response) || !isRecord(response.token)) {
    return "Token revoke response is missing token details.";
  }
  const token = response.token;
  return [
    `Personal access token ${stringValue(token.id) ?? "unknown"}`,
    `  name: ${stringValue(token.name) ?? "unnamed"}`,
    `  state: ${token.revoked_at ? "revoked" : "active"}`,
  ].join("\n");
}
