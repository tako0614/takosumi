import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
} from "@takosjp/takosumi-accounts-contract";

export type CapsuleRoute =
  | { kind: "installation"; capsuleId: string }
  | { kind: "status"; capsuleId: string }
  | { kind: "deployment"; capsuleId: string }
  | { kind: "deployment-plan-run"; capsuleId: string }
  | { kind: "rollback"; capsuleId: string }
  | { kind: "materialize"; capsuleId: string }
  | { kind: "export"; capsuleId: string }
  | { kind: "export-operation"; capsuleId: string; operationId: string }
  | { kind: "export-download"; capsuleId: string; operationId: string }
  | { kind: "events"; capsuleId: string }
  | { kind: "events-ingest"; capsuleId: string }
  | { kind: "services"; capsuleId: string }
  | {
      kind: "service-rotate-token";
      capsuleId: string;
      serviceId: string;
    }
  | { kind: "billing-usage-reports"; capsuleId: string }
  | { kind: "launch-token-consume"; capsuleId: string };

export function matchAccountTokenRevokeRoute(
  pathname: string,
): { tokenId: string } | null {
  const prefix = `${TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length !== 2 || parts[1] !== "revoke" || !parts[0]) return null;
  return { tokenId: parts[0] };
}

export function matchCapsuleRoute(
  pathname: string,
): CapsuleRoute | null {
  const prefix = `${TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  const capsuleId = parts[0];
  if (!capsuleId) return null;
  if (capsuleId === "import") return null;
  if (parts.length === 1) return { kind: "installation", capsuleId };
  if (parts.length === 2 && parts[1] === "status") {
    return { kind: "status", capsuleId };
  }
  if (parts.length === 2 && parts[1] === "deployments") {
    return { kind: "deployment", capsuleId };
  }
  if (
    parts.length === 3 &&
    parts[1] === "deployments" &&
    parts[2] === "plan-runs"
  ) {
    return { kind: "deployment-plan-run", capsuleId };
  }
  if (parts.length === 2 && parts[1] === "rollback") {
    return { kind: "rollback", capsuleId };
  }
  if (parts.length === 2 && parts[1] === "materialize") {
    return { kind: "materialize", capsuleId };
  }
  if (parts.length === 2 && parts[1] === "export") {
    return { kind: "export", capsuleId };
  }
  if (parts.length === 3 && parts[1] === "exports" && parts[2]) {
    return {
      kind: "export-operation",
      capsuleId,
      operationId: parts[2],
    };
  }
  if (
    parts.length === 4 &&
    parts[1] === "exports" &&
    parts[2] &&
    parts[3] === "download"
  ) {
    return {
      kind: "export-download",
      capsuleId,
      operationId: parts[2],
    };
  }
  if (parts.length === 2 && parts[1] === "events") {
    return { kind: "events", capsuleId };
  }
  if (parts.length === 3 && parts[1] === "events" && parts[2] === "ingest") {
    return { kind: "events-ingest", capsuleId };
  }
  if (parts.length === 2 && parts[1] === "services") {
    return { kind: "services", capsuleId };
  }
  if (
    parts.length === 4 &&
    parts[1] === "services" &&
    parts[2] &&
    parts[3] === "rotate-token"
  ) {
    return {
      kind: "service-rotate-token",
      capsuleId,
      serviceId: decodeURIComponent(parts[2]),
    };
  }
  if (
    parts.length === 3 &&
    parts[1] === "billing" &&
    parts[2] === "usage-reports"
  ) {
    return { kind: "billing-usage-reports", capsuleId };
  }
  if (
    parts.length === 3 &&
    parts[1] === "launch-token" &&
    parts[2] === "consume"
  ) {
    return { kind: "launch-token-consume", capsuleId };
  }
  return null;
}
