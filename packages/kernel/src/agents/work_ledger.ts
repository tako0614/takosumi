// Phase 18 / C5 — Persistent runtime-agent work ledger.
//
// The in-memory `InMemoryRuntimeAgentRegistry` only holds lease state in
// process memory. If the kernel restarts mid-flight, every long-running
// provider operation that an agent already leased loses its `leased`
// status and the kernel forgets it ever started — risking duplicate
// execution by the next agent that comes online.
//
// The work ledger gives the registry a durable side-channel:
//   1. Each `register` / `revoke` / `heartbeat` / `enqueueWork` /
//      `leaseWork` / `completeWork` / `failWork` / `reportProgress`
//      mutation is mirrored to the ledger transactionally.
//   2. On boot, the kernel calls `WorkLedger.snapshot()` and feeds the
//      result into `InMemoryRuntimeAgentRegistry.fromSnapshot()`. Stale
//      leases (whose `leaseExpiresAt` has elapsed) are rewritten to
//      `queued` so a fresh lease can pick them up on the next poll cycle.
//
// The reference implementation here (`InMemoryWorkLedger`) keeps state in
// memory but is intentionally separable from the registry so a Postgres /
// D1 / SQLite backed adapter can be dropped in without touching the
// registry surface. The DB schema for the durable adapter is defined by
// `db/migrations/20260430000011_runtime_agent_work_ledger.sql`.

import type {
  StorageDriver,
  StorageTransaction,
} from "../adapters/storage/driver.ts";
import type {
  RuntimeAgentId,
  RuntimeAgentRecord,
  RuntimeAgentWorkId,
  RuntimeAgentWorkItem,
} from "./types.ts";

/**
 * Atomic mutation envelope. Every registry operation that changes state
 * emits one of these so the ledger can persist agents + their work items
 * in a single transaction. The agent record may be `undefined` if the
 * mutation only touches a work item (e.g. `reportProgress`).
 */
export interface WorkLedgerMutation {
  readonly agent?: RuntimeAgentRecord;
  readonly works: readonly RuntimeAgentWorkItem[];
  /** Work items that have been removed (cancelled / pruned). */
  readonly removedWorkIds?: readonly RuntimeAgentWorkId[];
  /** Agents that have been removed (almost never used — prefer revoke). */
  readonly removedAgentIds?: readonly RuntimeAgentId[];
}

/**
 * Hydration snapshot the registry consumes on boot.
 */
export interface WorkLedgerSnapshot {
  readonly agents: readonly RuntimeAgentRecord[];
  readonly works: readonly RuntimeAgentWorkItem[];
}

/**
 * Persistent work ledger contract. Implementations must apply mutations
 * atomically (i.e. agent + works visible together, or not at all). The
 * reference DB-backed adapter wraps the mutation in a SQL transaction
 * over `runtime_agents` + `runtime_agent_work_items`.
 */
export interface WorkLedger {
  /** Read every persisted agent + work item. */
  snapshot(): Promise<WorkLedgerSnapshot>;
  /** Persist a registry mutation atomically. */
  apply(mutation: WorkLedgerMutation): Promise<void>;
}

/**
 * Reference in-memory implementation. Useful for tests and for booting
 * a single-node kernel before the persistent adapter is wired up.
 */
export class InMemoryWorkLedger implements WorkLedger {
  readonly #agents = new Map<RuntimeAgentId, RuntimeAgentRecord>();
  readonly #works = new Map<RuntimeAgentWorkId, RuntimeAgentWorkItem>();

  constructor(initial?: WorkLedgerSnapshot) {
    if (initial) {
      for (const agent of initial.agents) this.#agents.set(agent.id, agent);
      for (const work of initial.works) this.#works.set(work.id, work);
    }
  }

  snapshot(): Promise<WorkLedgerSnapshot> {
    return Promise.resolve({
      agents: [...this.#agents.values()],
      works: [...this.#works.values()],
    });
  }

  apply(mutation: WorkLedgerMutation): Promise<void> {
    if (mutation.agent) this.#agents.set(mutation.agent.id, mutation.agent);
    for (const work of mutation.works) this.#works.set(work.id, work);
    for (const removed of mutation.removedWorkIds ?? []) {
      this.#works.delete(removed);
    }
    for (const removed of mutation.removedAgentIds ?? []) {
      this.#agents.delete(removed);
    }
    return Promise.resolve();
  }
}

/**
 * Storage-backed ledger adapter. The registry remains storage-agnostic while
 * app boot can still bind runtime-agent state to the same transactional
 * storage boundary as the rest of the PaaS runtime.
 */
export class StorageBackedWorkLedger implements WorkLedger {
  readonly #driver: StorageDriver;

  constructor(driver: StorageDriver) {
    this.#driver = driver;
  }

  snapshot(): Promise<WorkLedgerSnapshot> {
    return this.#driver.transaction((tx) => tx.runtimeAgent.snapshot());
  }

  apply(mutation: WorkLedgerMutation): Promise<void> {
    return this.#driver.transaction((tx) => tx.runtimeAgent.apply(mutation));
  }
}

export type RuntimeAgentLedgerStorageTransaction = Pick<
  StorageTransaction,
  "runtimeAgent"
>;

/**
 * Boot helper — produces a snapshot suitable for hydrating a fresh
 * `InMemoryRuntimeAgentRegistry`, with stale leases rewritten back to
 * `queued`. Stale = `status === 'leased'` and `leaseExpiresAt <= now`.
 *
 * The kernel calls this once on boot before the registry starts handing
 * out new leases. Returning the affected work IDs lets callers emit a
 * `runtime.work.requeued_on_boot` audit event.
 */
export interface RehydrateRegistryOptions {
  readonly now?: string;
}

export interface RehydratedRegistryState {
  readonly snapshot: WorkLedgerSnapshot;
  readonly requeuedWorkIds: readonly RuntimeAgentWorkId[];
}

export function rehydrateLeases(
  raw: WorkLedgerSnapshot,
  options: RehydrateRegistryOptions = {},
): RehydratedRegistryState {
  const now = options.now ?? new Date().toISOString();
  const requeued: RuntimeAgentWorkId[] = [];
  const works = raw.works.map((work) => {
    if (work.status !== "leased") return work;
    if (!work.leaseExpiresAt || work.leaseExpiresAt > now) {
      // Lease window is still valid — let the in-memory registry continue
      // to honour it, the agent will re-attach via heartbeat.
      return work;
    }
    requeued.push(work.id);
    return {
      ...work,
      status: "queued" as const,
      leasedByAgentId: undefined,
      leaseId: undefined,
      leaseExpiresAt: undefined,
    };
  });
  return {
    snapshot: { agents: raw.agents, works },
    requeuedWorkIds: requeued,
  };
}
