import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
} from "@takosjp/takosumi-accounts-contract";

export type InstallationRoute =
  | { kind: "installation"; installationId: string }
  | { kind: "status"; installationId: string }
  | { kind: "deployment"; installationId: string }
  | { kind: "deployment-plan-run"; installationId: string }
  | { kind: "rollback"; installationId: string }
  | { kind: "materialize"; installationId: string }
  | { kind: "export"; installationId: string }
  | { kind: "export-operation"; installationId: string; operationId: string }
  | { kind: "export-download"; installationId: string; operationId: string }
  | { kind: "events"; installationId: string }
  | { kind: "events-ingest"; installationId: string }
  | { kind: "services"; installationId: string }
  | {
    kind: "service-rotate-token";
    installationId: string;
    serviceId: string;
  }
  | { kind: "billing-usage-reports"; installationId: string }
  | { kind: "launch-token-consume"; installationId: string };

export function matchAccountTokenRevokeRoute(
  pathname: string,
): { tokenId: string } | null {
  const prefix = `${TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 2 || parts[1] !== "revoke" || !parts[0]) return null;
  return { tokenId: parts[0] };
}

export function matchInstallationRoute(
  pathname: string,
): InstallationRoute | null {
  const prefix = `${TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  const installationId = parts[0];
  if (!installationId) return null;
  if (parts.length === 1) return { kind: "installation", installationId };
  if (parts.length === 2 && parts[1] === "status") {
    return { kind: "status", installationId };
  }
  if (parts.length === 2 && parts[1] === "deployments") {
    return { kind: "deployment", installationId };
  }
  if (
    parts.length === 3 && parts[1] === "deployments" &&
    parts[2] === "plan-runs"
  ) {
    return { kind: "deployment-plan-run", installationId };
  }
  if (parts.length === 2 && parts[1] === "rollback") {
    return { kind: "rollback", installationId };
  }
  if (parts.length === 2 && parts[1] === "materialize") {
    return { kind: "materialize", installationId };
  }
  if (parts.length === 2 && parts[1] === "export") {
    return { kind: "export", installationId };
  }
  if (parts.length === 3 && parts[1] === "exports" && parts[2]) {
    return {
      kind: "export-operation",
      installationId,
      operationId: parts[2],
    };
  }
  if (
    parts.length === 4 && parts[1] === "exports" && parts[2] &&
    parts[3] === "download"
  ) {
    return {
      kind: "export-download",
      installationId,
      operationId: parts[2],
    };
  }
  if (parts.length === 2 && parts[1] === "events") {
    return { kind: "events", installationId };
  }
  if (parts.length === 3 && parts[1] === "events" && parts[2] === "ingest") {
    return { kind: "events-ingest", installationId };
  }
  if (parts.length === 2 && parts[1] === "services") {
    return { kind: "services", installationId };
  }
  if (
    parts.length === 4 && parts[1] === "services" && parts[2] &&
    parts[3] === "rotate-token"
  ) {
    return {
      kind: "service-rotate-token",
      installationId,
      serviceId: decodeURIComponent(parts[2]),
    };
  }
  if (
    parts.length === 3 && parts[1] === "billing" &&
    parts[2] === "usage-reports"
  ) {
    return { kind: "billing-usage-reports", installationId };
  }
  if (
    parts.length === 3 && parts[1] === "launch-token" && parts[2] === "consume"
  ) {
    return { kind: "launch-token-consume", installationId };
  }
  return null;
}
