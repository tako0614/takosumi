import { isRecord, stringValue } from "./cli-util.ts";

export function formatAccountsTokensList(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  const tokens = isRecord(response) && Array.isArray(response.tokens)
    ? response.tokens
    : [];
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

export function formatInstallationsList(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  const installations =
    isRecord(response) && Array.isArray(response.installations)
      ? response.installations
      : [];
  if (installations.length === 0) return "No installations found.";
  const lines = ["Installations:"];
  for (const value of installations) {
    if (!isRecord(value)) continue;
    lines.push(
      `  ${stringValue(value.id) ?? "unknown"}  ${
        stringValue(value.status) ?? "unknown"
      }  ${stringValue(value.app_id) ?? "unknown-app"}  ${
        stringValue(value.mode) ?? "unknown-mode"
      }`,
    );
  }
  lines.push(`${installations.length} installation(s)`);
  return lines.join("\n");
}

export function formatInstallationInspect(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response) || !isRecord(response.installation)) {
    return "Installation response is missing installation details.";
  }
  const installation = response.installation;
  const lines = [
    `Installation ${stringValue(installation.id) ?? "unknown"}`,
    `  status: ${stringValue(installation.status) ?? "unknown"}`,
    `  app: ${stringValue(installation.app_id) ?? "unknown-app"}`,
    `  mode: ${stringValue(installation.mode) ?? "unknown-mode"}`,
    `  space: ${stringValue(installation.space_id) ?? "unknown-space"}`,
  ];
  if (isRecord(installation.source)) {
    lines.push(
      `  source: ${stringValue(installation.source.url) ?? "unknown"}@${
        stringValue(installation.source.ref) ?? "unknown-ref"
      }`,
    );
  }
  const useEdges = Array.isArray(response.use_edges) ? response.use_edges : [];
  if (useEdges.length > 0) {
    lines.push("Use edges:");
    for (const value of useEdges) {
      if (!isRecord(value)) continue;
      lines.push(
        `  ${stringValue(value.name) ?? "unknown"}  ${
          stringValue(value.kind) ?? "unknown"
        }`,
      );
    }
  }
  if (isRecord(response.oidc_client)) {
    lines.push("OIDC Client:");
    lines.push(
      `  ${stringValue(response.oidc_client.client_id) ?? "unknown"}  ${
        stringValue(response.oidc_client.token_endpoint_auth_method) ??
          "unknown-auth"
      }`,
    );
    const redirectUris = Array.isArray(response.oidc_client.redirect_uris)
      ? response.oidc_client.redirect_uris.filter((value) =>
        typeof value === "string" && value.length > 0
      )
      : [];
    if (redirectUris.length > 0) {
      lines.push(`  redirects: ${redirectUris.join(", ")}`);
    }
  }
  const permissionScopes = Array.isArray(response.permission_scopes)
    ? response.permission_scopes
    : [];
  if (permissionScopes.length > 0) {
    lines.push("Permission scopes:");
    for (const value of permissionScopes) {
      if (!isRecord(value)) continue;
      lines.push(
        `  ${stringValue(value.capability) ?? "unknown"}  ${
          value.revoked_at ? "revoked" : "active"
        }`,
      );
    }
  }
  return lines.join("\n");
}

export function formatInstallationStatus(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response) || !isRecord(response.installation)) {
    return "Installation status response is missing installation details.";
  }
  const installation = response.installation;
  return [
    `Installation ${stringValue(installation.id) ?? "unknown"}`,
    `  status: ${stringValue(installation.status) ?? "unknown"}`,
  ].join("\n");
}

export function formatInstallationUninstall(
  response: unknown,
  asJson: boolean,
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response) || !isRecord(response.installation)) {
    return "Installation uninstall response is missing installation details.";
  }
  const installation = response.installation;
  const revokedPermissionScopes = Array.isArray(
      response.revoked_permission_scopes,
    )
    ? response.revoked_permission_scopes
    : [];
  const lines = [
    `Installation ${stringValue(installation.id) ?? "unknown"}`,
    `  status: ${stringValue(installation.status) ?? "unknown"}`,
    `  revoked permission scopes: ${revokedPermissionScopes.length}`,
  ];
  if (isRecord(response.event)) {
    lines.push(`  event: ${stringValue(response.event.type) ?? "unknown"}`);
  }
  return lines.join("\n");
}

export function formatInstallationOperation(
  response: unknown,
  asJson: boolean,
  label: "Materialize" | "Export",
): string {
  if (asJson) return JSON.stringify(response, null, 2);
  if (!isRecord(response)) {
    return `${label} operation response is missing operation details.`;
  }
  const operationId = stringValue(response.operationId) ?? "unknown";
  const lines = [`${label} operation ${operationId}`];
  const installationId = stringValue(response.installationId);
  if (installationId) lines.push(`  installation: ${installationId}`);
  const status = stringValue(response.status);
  if (status) lines.push(`  status: ${status}`);
  const fromMode = stringValue(response.fromMode);
  const toMode = stringValue(response.toMode);
  if (fromMode || toMode) {
    lines.push(`  mode: ${fromMode ?? "unknown"} -> ${toMode ?? "unknown"}`);
  }
  const trackingUrl = stringValue(response.trackingUrl);
  if (trackingUrl) lines.push(`  tracking: ${trackingUrl}`);
  const downloadUrl = stringValue(response.downloadUrl);
  if (downloadUrl) lines.push(`  download: ${downloadUrl}`);
  return lines.join("\n");
}
