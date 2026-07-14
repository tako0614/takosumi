import type {
  TakosumiAccountsCompletePrivacyRequestRequest,
  TakosumiAccountsCreatePrivacyRequestRequest,
  TakosumiAccountsListPrivacyRequestsResponse,
  TakosumiAccountsPrivacyRequest,
  TakosumiAccountsPrivacyRequestResponse,
  TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type {
  AccountsStore,
  PrivacyRequestKind,
  PrivacyRequestRecord,
  PrivacyRequestStatus,
} from "./store.ts";
import {
  errorJson,
  json,
  readJsonObject,
  stringValue,
} from "./http-helpers.ts";

const allowedKinds = new Set<PrivacyRequestKind>(["export", "delete"]);
const terminalStatuses = new Set<PrivacyRequestStatus>([
  "exported",
  "login_disabled",
  "deleted",
  "rejected",
]);

const privacyRequestIdPattern = /^prq_[a-z0-9]{20}$/;
const requestSummaryMaxLength = 500;

export interface PrivacyRequestRoute {
  requestId: string;
  action?: "complete";
}

export function matchPrivacyRequestRoute(
  pathname: string,
  basePath: string,
): PrivacyRequestRoute | undefined {
  if (!pathname.startsWith(`${basePath}/`)) return undefined;
  const parts = pathname.slice(basePath.length + 1).split("/");
  if (parts.length === 1 && privacyRequestIdPattern.test(parts[0])) {
    return { requestId: parts[0] };
  }
  if (
    parts.length === 2 &&
    privacyRequestIdPattern.test(parts[0]) &&
    parts[1] === "complete"
  ) {
    return { requestId: parts[0], action: "complete" };
  }
  return undefined;
}

export async function handleCreatePrivacyRequest(input: {
  request: Request;
  store: AccountsStore;
  subject: TakosumiSubject;
  /** Host-owned retention policy reference; Accounts never invents one. */
  policyRef?: string;
  now?: number;
}): Promise<Response> {
  if (!input.policyRef) {
    return errorJson(
      "privacy_policy_unavailable",
      "privacy retention policy is not configured",
      503,
      input.request,
    );
  }
  const body = (await readJsonObject(
    input.request,
  )) as TakosumiAccountsCreatePrivacyRequestRequest | null;
  if (!body) {
    return errorJson(
      "invalid_request",
      "request body must be a JSON object",
      400,
      input.request,
    );
  }
  const kind = privacyRequestKindValue(body.kind);
  if (!kind) {
    return errorJson(
      "invalid_privacy_request_kind",
      "kind must be export or delete",
      400,
      input.request,
    );
  }
  const requestSummary = optionalRequestSummary(body.request_summary);
  if (requestSummary === null) {
    return errorJson(
      "invalid_request_summary",
      `request_summary must be at most ${requestSummaryMaxLength} characters`,
      400,
      input.request,
    );
  }
  const now = input.now ?? Date.now();
  const record: PrivacyRequestRecord = {
    requestId: opaquePrivacyRequestId(),
    subject: input.subject,
    kind,
    status: "received",
    retentionRecordId: `ret_${input.subject}_${now}`,
    policyRef: input.policyRef,
    ...(requestSummary ? { requestSummary } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await input.store.savePrivacyRequest(record);
  return json(privacyRequestResponse(record), 201, {
    "cache-control": "no-store",
  });
}

export function normalizePrivacyRetentionPolicyRef(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    !/^[^\s\x00-\x1f\x7f]+$/u.test(normalized)
  ) {
    throw new TypeError(
      "privacyRetentionPolicyRef must be a non-blank opaque reference without whitespace",
    );
  }
  return normalized;
}

export async function handleListPrivacyRequests(input: {
  store: AccountsStore;
  subject: TakosumiSubject;
}): Promise<Response> {
  const records = await input.store.listPrivacyRequestsForSubject(
    input.subject,
  );
  return json(
    {
      requests: records.map(publicPrivacyRequest),
    } satisfies TakosumiAccountsListPrivacyRequestsResponse,
    200,
    { "cache-control": "no-store" },
  );
}

export async function handleGetPrivacyRequest(input: {
  request: Request;
  store: AccountsStore;
  subject: TakosumiSubject;
  requestId: string;
}): Promise<Response> {
  const record = await input.store.findPrivacyRequest(input.requestId);
  if (!record || record.subject !== input.subject) {
    return errorJson(
      "privacy_request_not_found",
      "privacy request not found",
      404,
      input.request,
    );
  }
  return json(privacyRequestResponse(record), 200, {
    "cache-control": "no-store",
  });
}

export async function handleCompletePrivacyRequest(input: {
  request: Request;
  store: AccountsStore;
  requestId: string;
  now?: number;
}): Promise<Response> {
  const body = (await readJsonObject(
    input.request,
  )) as TakosumiAccountsCompletePrivacyRequestRequest | null;
  if (!body) {
    return errorJson(
      "invalid_request",
      "request body must be a JSON object",
      400,
      input.request,
    );
  }
  const record = await input.store.findPrivacyRequest(input.requestId);
  if (!record) {
    return errorJson(
      "privacy_request_not_found",
      "privacy request not found",
      404,
      input.request,
    );
  }
  const status = privacyRequestTerminalStatusValue(body.status);
  if (!status) {
    return errorJson(
      "invalid_privacy_request_status",
      "status must be exported, login_disabled, deleted, or rejected",
      400,
      input.request,
    );
  }
  const statusBlocked = invalidCompletionStatus(record.kind, status);
  if (statusBlocked) {
    return errorJson(
      "invalid_privacy_request_status",
      statusBlocked,
      400,
      input.request,
    );
  }
  const requestSummary = optionalRequestSummary(body.request_summary);
  if (requestSummary === null) {
    return errorJson(
      "invalid_request_summary",
      `request_summary must be at most ${requestSummaryMaxLength} characters`,
      400,
      input.request,
    );
  }
  const exportRef = optionalReference(body.export_ref);
  if (exportRef === null) {
    return errorJson(
      "invalid_export_ref",
      "export_ref must be at most 256 characters",
      400,
      input.request,
    );
  }
  const now = input.now ?? Date.now();
  const next: PrivacyRequestRecord = {
    ...record,
    status,
    ...(requestSummary ? { requestSummary } : {}),
    ...(exportRef ? { exportRef } : {}),
    completedAt: now,
    updatedAt: now,
  };
  await input.store.savePrivacyRequest(next);
  return json(privacyRequestResponse(next), 200, {
    "cache-control": "no-store",
  });
}

function privacyRequestResponse(
  record: PrivacyRequestRecord,
): TakosumiAccountsPrivacyRequestResponse {
  return { request: publicPrivacyRequest(record) };
}

function publicPrivacyRequest(
  record: PrivacyRequestRecord,
): TakosumiAccountsPrivacyRequest {
  return {
    request_id: record.requestId,
    subject: record.subject,
    kind: record.kind,
    status: record.status,
    retention_record_id: record.retentionRecordId,
    policy_ref: record.policyRef,
    ...(record.requestSummary
      ? { request_summary: record.requestSummary }
      : {}),
    ...(record.exportRef ? { export_ref: record.exportRef } : {}),
    ...(record.completedAt
      ? { completed_at: new Date(record.completedAt).toISOString() }
      : {}),
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
  };
}

function privacyRequestKindValue(
  value: unknown,
): PrivacyRequestKind | undefined {
  return typeof value === "string" && allowedKinds.has(value as never)
    ? (value as PrivacyRequestKind)
    : undefined;
}

function privacyRequestTerminalStatusValue(
  value: unknown,
): PrivacyRequestStatus | undefined {
  return typeof value === "string" && terminalStatuses.has(value as never)
    ? (value as PrivacyRequestStatus)
    : undefined;
}

function invalidCompletionStatus(
  kind: PrivacyRequestKind,
  status: PrivacyRequestStatus,
): string | undefined {
  if (kind === "export" && status !== "exported" && status !== "rejected") {
    return "export requests can only complete as exported or rejected";
  }
  if (
    kind === "delete" &&
    status !== "login_disabled" &&
    status !== "deleted" &&
    status !== "rejected"
  ) {
    return "delete requests can only complete as login_disabled, deleted, or rejected";
  }
  return undefined;
}

function optionalRequestSummary(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const text = stringValue(value)?.trim();
  if (!text) return undefined;
  return text.length <= requestSummaryMaxLength ? text : null;
}

function optionalReference(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const text = stringValue(value)?.trim();
  if (!text) return undefined;
  return text.length <= 256 ? text : null;
}

function opaquePrivacyRequestId(): string {
  return `prq_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
