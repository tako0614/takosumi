import { conflict, invalidArgument } from "../../shared/errors.ts";
import type {
  ChangeSetAttemptReport,
  ChangeSetChange,
  ChangeSetChangeResultDto,
  ChangeSetDependencyEdge,
  ChangeSetPartialSuccessResultDto,
  ChangeSetPartialSuccessSemanticsDto,
  ChangeSetPlan,
  ChangeSetPlanInput,
} from "./types.ts";

const PARTIAL_SUCCESS_SEMANTICS: ChangeSetPartialSuccessSemanticsDto = Object
  .freeze({
    kind: "change_set_partial_success_semantics" as const,
    distributedTransaction: false as const,
    atomic: false as const,
    rollback: "not-automatic" as const,
    failureMode: "failed-change-blocks-dependents-only" as const,
    resultContract:
      "each change is reported as succeeded, failed, skipped, or pending" as const,
  });

export class ChangeSetPlanner {
  plan(input: ChangeSetPlanInput): ChangeSetPlan {
    return buildChangeSetPlan(input);
  }

  result(
    plan: ChangeSetPlan,
    attempts: readonly ChangeSetAttemptReport[],
  ): ChangeSetPartialSuccessResultDto {
    return buildChangeSetPartialSuccessResult(plan, attempts);
  }
}

export function buildChangeSetPlan(input: ChangeSetPlanInput): ChangeSetPlan {
  const changes = [...input.changes];
  const changeById = new Map<string, ChangeSetChange>();
  for (const change of changes) {
    if (changeById.has(change.id)) {
      throw invalidArgument("Duplicate change-set change id", {
        changeId: change.id,
      });
    }
    changeById.set(change.id, change);
  }

  const edges = buildDependencyEdges(changes, changeById);
  const topologicalOrder = topologicalSort(changeById, edges);
  const dependenciesById = new Map<string, Set<string>>();
  const dependentsById = new Map<string, Set<string>>();
  for (const change of changes) {
    dependenciesById.set(change.id, new Set());
    dependentsById.set(change.id, new Set());
  }
  for (const edge of edges) {
    dependenciesById.get(edge.toChangeId)?.add(edge.fromChangeId);
    dependentsById.get(edge.fromChangeId)?.add(edge.toChangeId);
  }

  return deepFreeze({
    kind: "change_set_plan" as const,
    id: input.id,
    nodes: topologicalOrder.map((changeId) => ({
      change: changeById.get(changeId)!,
      dependencies: [...dependenciesById.get(changeId)!].sort(),
      dependents: [...dependentsById.get(changeId)!].sort(),
    })),
    edges,
    topologicalOrder,
    executionSemantics: PARTIAL_SUCCESS_SEMANTICS,
  });
}

export function buildChangeSetPartialSuccessResult(
  plan: ChangeSetPlan,
  attempts: readonly ChangeSetAttemptReport[],
): ChangeSetPartialSuccessResultDto {
  const attemptByChangeId = new Map<string, ChangeSetAttemptReport>();
  for (const attempt of attempts) {
    if (attemptByChangeId.has(attempt.changeId)) {
      throw invalidArgument("Duplicate change-set attempt report", {
        changeId: attempt.changeId,
      });
    }
    attemptByChangeId.set(attempt.changeId, attempt);
  }

  const dependenciesById = new Map(
    plan.nodes.map((node) => [node.change.id, node.dependencies]),
  );
  const resultByChangeId = new Map<string, ChangeSetChangeResultDto>();
  const changes: ChangeSetChangeResultDto[] = [];

  for (const changeId of plan.topologicalOrder) {
    const dependencies = dependenciesById.get(changeId) ?? [];
    const blockedBy = dependencies.filter((dependencyId) => {
      const dependency = resultByChangeId.get(dependencyId);
      return dependency?.status === "failed" ||
        dependency?.status === "skipped";
    });
    const attempt = attemptByChangeId.get(changeId);
    const result: ChangeSetChangeResultDto = blockedBy.length > 0
      ? {
        changeId,
        status: "skipped" as const,
        blockedBy,
        message: "dependency did not succeed",
      }
      : attempt
      ? {
        changeId,
        status: attempt.status,
        blockedBy: [],
        message: attempt.message,
      }
      : {
        changeId,
        status: "pending" as const,
        blockedBy: [],
      };
    const frozen = Object.freeze(result);
    resultByChangeId.set(changeId, frozen);
    changes.push(frozen);
  }

  const summary = Object.freeze({
    succeeded: changes.filter((change) => change.status === "succeeded").length,
    failed: changes.filter((change) => change.status === "failed").length,
    skipped: changes.filter((change) => change.status === "skipped").length,
    pending: changes.filter((change) => change.status === "pending").length,
  });

  return deepFreeze({
    kind: "change_set_apply_result" as const,
    planId: plan.id,
    status: resultStatus(summary),
    distributedTransaction: false as const,
    summary,
    changes,
  });
}

function buildDependencyEdges(
  changes: readonly ChangeSetChange[],
  changeById: ReadonlyMap<string, ChangeSetChange>,
): readonly ChangeSetDependencyEdge[] {
  const edges: ChangeSetDependencyEdge[] = [];
  for (const change of changes) {
    for (const dependencyId of change.dependsOn ?? []) {
      if (!changeById.has(dependencyId)) {
        throw invalidArgument(
          "Change-set dependency references unknown change",
          {
            changeId: change.id,
            dependencyId,
          },
        );
      }
      edges.push({
        fromChangeId: dependencyId,
        toChangeId: change.id,
        reason: "explicit",
      });
    }
  }

  for (
    const groupChange of changes.filter((change) => change.kind === "group")
  ) {
    const groupId = groupChange.groupId ?? groupChange.id;
    for (const childChange of changes) {
      if (childChange.id === groupChange.id || childChange.kind === "group") {
        continue;
      }
      if (childChange.groupId !== groupId) continue;
      if (groupChange.operation === "delete") {
        edges.push({
          fromChangeId: childChange.id,
          toChangeId: groupChange.id,
          reason: "child-before-group-delete",
        });
      } else {
        edges.push({
          fromChangeId: groupChange.id,
          toChangeId: childChange.id,
          reason: "group-before-child",
        });
      }
    }
  }

  return dedupeEdges(edges).sort(compareEdges);
}

function topologicalSort(
  changes: ReadonlyMap<string, ChangeSetChange>,
  edges: readonly ChangeSetDependencyEdge[],
): readonly string[] {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const changeId of changes.keys()) {
    inDegree.set(changeId, 0);
    outgoing.set(changeId, []);
  }
  for (const edge of edges) {
    inDegree.set(edge.toChangeId, (inDegree.get(edge.toChangeId) ?? 0) + 1);
    outgoing.get(edge.fromChangeId)?.push(edge.toChangeId);
  }
  for (const dependents of outgoing.values()) dependents.sort();

  const ready = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([changeId]) => changeId)
    .sort();
  const ordered: string[] = [];

  while (ready.length > 0) {
    const changeId = ready.shift()!;
    ordered.push(changeId);
    for (const dependentId of outgoing.get(changeId) ?? []) {
      const nextDegree = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, nextDegree);
      if (nextDegree === 0) ready.push(dependentId);
    }
    ready.sort();
  }

  if (ordered.length !== changes.size) {
    throw conflict("Change-set dependency cycle detected", {
      cycle: findCycle(changes, edges),
    });
  }
  return Object.freeze(ordered);
}

function findCycle(
  changes: ReadonlyMap<string, ChangeSetChange>,
  edges: readonly ChangeSetDependencyEdge[],
): readonly string[] {
  const graph = new Map<string, string[]>();
  for (const changeId of changes.keys()) graph.set(changeId, []);
  for (const edge of edges) graph.get(edge.fromChangeId)?.push(edge.toChangeId);
  for (const next of graph.values()) next.sort();

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (changeId: string): readonly string[] | undefined => {
    if (visiting.has(changeId)) {
      const start = stack.indexOf(changeId);
      return [...stack.slice(start), changeId];
    }
    if (visited.has(changeId)) return undefined;
    visiting.add(changeId);
    stack.push(changeId);
    for (const next of graph.get(changeId) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(changeId);
    visited.add(changeId);
    return undefined;
  };

  for (const changeId of [...changes.keys()].sort()) {
    const cycle = visit(changeId);
    if (cycle) return cycle;
  }
  return [];
}

function dedupeEdges(
  edges: readonly ChangeSetDependencyEdge[],
): ChangeSetDependencyEdge[] {
  const seen = new Set<string>();
  const deduped: ChangeSetDependencyEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.fromChangeId}\0${edge.toChangeId}\0${edge.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}

function compareEdges(
  a: ChangeSetDependencyEdge,
  b: ChangeSetDependencyEdge,
): number {
  return a.fromChangeId.localeCompare(b.fromChangeId) ||
    a.toChangeId.localeCompare(b.toChangeId) ||
    a.reason.localeCompare(b.reason);
}

function resultStatus(summary: {
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly pending: number;
}) {
  if (summary.failed === 0 && summary.skipped === 0 && summary.pending === 0) {
    return "succeeded" as const;
  }
  if (summary.succeeded === 0 && (summary.failed > 0 || summary.skipped > 0)) {
    return "failed" as const;
  }
  if (summary.failed === 0 && summary.skipped === 0 && summary.pending > 0) {
    return "pending" as const;
  }
  return "partial_success" as const;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (
      typeof nested === "object" && nested !== null && !Object.isFrozen(nested)
    ) {
      deepFreeze(nested);
    }
  }
  return value;
}
