import type { CoreRole } from "../../domains/core/mod.ts";
import type { ApprovalStore } from "./store.ts";
import { InMemoryApprovalStore } from "./store.ts";
import type {
  ApprovalActor,
  ApprovalGateDecision,
  ApprovalGateInput,
  ApprovalKind,
  ApprovalRecord,
  ApprovalRequirement,
  ApprovalSubject,
  ApprovalSubjectRef,
} from "./types.ts";

export interface ApprovalServiceOptions {
  readonly store?: ApprovalStore;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
}

export interface RecordApprovalInput<T = unknown> extends ApprovalSubject<T> {
  readonly actor: ApprovalActor;
  readonly kind: ApprovalKind;
  readonly requiredRoles?: readonly CoreRole[];
  readonly approvedAt?: string;
}

export class ApprovalService {
  readonly #store: ApprovalStore;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;

  constructor(options: ApprovalServiceOptions = {}) {
    this.#store = options.store ?? new InMemoryApprovalStore();
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date());
  }

  async recordManualApproval<T>(
    input: Omit<RecordApprovalInput<T>, "kind">,
  ): Promise<ApprovalRecord> {
    return await this.#recordApproval({ ...input, kind: "manual" });
  }

  async recordRoleApproval<T>(
    input: Omit<RecordApprovalInput<T>, "kind"> & {
      readonly requiredRoles: readonly CoreRole[];
    },
  ): Promise<ApprovalRecord> {
    const missingRoles = missingRequiredRoles(
      input.actor.roles,
      input.requiredRoles,
    );
    if (missingRoles.length > 0) {
      throw new TypeError(
        `actor is missing approval role: ${missingRoles.join(",")}`,
      );
    }
    return await this.#recordApproval({ ...input, kind: "role" });
  }

  async checkPlanGate<T>(
    input: Omit<ApprovalGateInput<T>, "operation">,
  ): Promise<ApprovalGateDecision> {
    return await this.checkGate({ ...input, operation: "deploy.plan" });
  }

  async checkApplyGate<T>(
    input: Omit<ApprovalGateInput<T>, "operation">,
  ): Promise<ApprovalGateDecision> {
    return await this.checkGate({ ...input, operation: "deploy.apply" });
  }

  async checkGate<T>(
    input: ApprovalGateInput<T>,
  ): Promise<ApprovalGateDecision> {
    const digest = await subjectDigest(input.subject);
    const checkedAt = input.checkedAt ?? this.#now();
    await this.#store.invalidateSubjectDigest({
      subject: input,
      subjectDigest: digest,
      invalidatedAt: checkedAt,
      reason: "subject-digest-changed",
    });

    const requirement = input.requirement ?? {};
    if (!requiresApproval(requirement)) {
      return Object.freeze({
        allowed: true,
        operation: input.operation,
        subjectDigest: digest,
        reason: "approval not required",
      });
    }

    const roleDecision = await this.#checkRoleRequirement(
      input,
      digest,
      requirement.roles ?? [],
    );
    if (roleDecision.allowed) return roleDecision;

    if (requirement.manual) {
      const approval = await this.#findValidApproval(input, digest, [
        "manual",
      ]);
      if (approval) {
        return Object.freeze({
          allowed: true,
          operation: input.operation,
          subjectDigest: digest,
          reason: "manual approval valid",
          approval,
        });
      }
    }

    return Object.freeze({
      allowed: false,
      operation: input.operation,
      subjectDigest: digest,
      reason: requirement.manual
        ? "manual approval required"
        : "role approval required",
      missingRoles: roleDecision.missingRoles,
    });
  }

  async #recordApproval<T>(
    input: RecordApprovalInput<T>,
  ): Promise<ApprovalRecord> {
    const digest = await subjectDigest(input.subject);
    const approvedAt = input.approvedAt ?? this.#now();
    await this.#store.invalidateSubjectDigest({
      subject: input,
      subjectDigest: digest,
      invalidatedAt: approvedAt,
      reason: "subject-digest-changed",
    });
    return await this.#store.put({
      id: this.#idFactory(),
      spaceId: input.spaceId,
      groupId: input.groupId,
      operation: input.operation,
      subjectId: input.subjectId,
      subjectDigest: digest,
      kind: input.kind,
      status: "valid",
      approvedBy: input.actor.accountId,
      approvedByRoles: [...input.actor.roles],
      approvedAt,
      requiredRoles: input.requiredRoles ? [...input.requiredRoles] : undefined,
    });
  }

  async #checkRoleRequirement(
    input: ApprovalGateInput,
    subjectDigestValue: string,
    roles: readonly CoreRole[],
  ): Promise<ApprovalGateDecision> {
    if (roles.length === 0) {
      return Object.freeze({
        allowed: false,
        operation: input.operation,
        subjectDigest: subjectDigestValue,
        reason: "no role approval requirement",
      });
    }

    const missingRoles = missingRequiredRoles(input.actor.roles, roles);
    if (missingRoles.length === 0) {
      return Object.freeze({
        allowed: true,
        operation: input.operation,
        subjectDigest: subjectDigestValue,
        reason: "actor role satisfies approval gate",
      });
    }

    const approval = await this.#findValidApproval(
      input,
      subjectDigestValue,
      [
        "role",
      ],
    );
    if (approval && hasAnyRole(approval.approvedByRoles, roles)) {
      return Object.freeze({
        allowed: true,
        operation: input.operation,
        subjectDigest: subjectDigestValue,
        reason: "stored role approval valid",
        approval,
      });
    }

    return Object.freeze({
      allowed: false,
      operation: input.operation,
      subjectDigest: subjectDigestValue,
      reason: "actor missing approval role",
      missingRoles,
    });
  }

  async #findValidApproval(
    subject: ApprovalSubjectRef,
    digest: string,
    kinds: readonly ApprovalKind[],
  ): Promise<ApprovalRecord | undefined> {
    const approvals = await this.#store.listBySubject(subject);
    return approvals.find((approval) =>
      approval.status === "valid" &&
      approval.subjectDigest === digest &&
      kinds.includes(approval.kind)
    );
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

export async function subjectDigest(subject: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(stableJson(subject));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

function requiresApproval(requirement: ApprovalRequirement): boolean {
  return requirement.manual === true || (requirement.roles?.length ?? 0) > 0;
}

function missingRequiredRoles(
  actorRoles: readonly CoreRole[],
  requiredRoles: readonly CoreRole[],
): readonly CoreRole[] {
  if (requiredRoles.length === 0) return [];
  if (hasAnyRole(actorRoles, requiredRoles)) return [];
  return [...requiredRoles];
}

function hasAnyRole(
  actual: readonly CoreRole[],
  expected: readonly CoreRole[],
): boolean {
  return expected.some((role) => actual.includes(role));
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}
