// In-memory implementation of the runtime-agent WorkLedger. Stores
// both the agent registry and the per-agent work item collection in
// two Maps and applies mutations atomically (inside the surrounding
// MemoryStorageTransaction).

import type {
  RuntimeAgentId,
  RuntimeAgentRecord,
  RuntimeAgentWorkId,
  RuntimeAgentWorkItem,
  WorkLedger,
  WorkLedgerMutation,
  WorkLedgerSnapshot,
} from "../../../agents/mod.ts";
import { immutable } from "./helpers.ts";

export class MemoryRuntimeAgentLedgerStore implements WorkLedger {
  constructor(
    private readonly agents: Map<RuntimeAgentId, RuntimeAgentRecord>,
    private readonly works: Map<RuntimeAgentWorkId, RuntimeAgentWorkItem>,
  ) {}

  snapshot(): Promise<WorkLedgerSnapshot> {
    return Promise.resolve(immutable({
      agents: [...this.agents.values()],
      works: [...this.works.values()],
    }));
  }

  apply(mutation: WorkLedgerMutation): Promise<void> {
    if (mutation.agent) {
      this.agents.set(mutation.agent.id, immutable(mutation.agent));
    }
    for (const work of mutation.works) {
      this.works.set(work.id, immutable(work));
    }
    for (const removed of mutation.removedWorkIds ?? []) {
      this.works.delete(removed);
    }
    for (const removed of mutation.removedAgentIds ?? []) {
      this.agents.delete(removed);
    }
    return Promise.resolve();
  }
}
