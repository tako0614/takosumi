// runner/lib/timing.ts
//
// Small runner-phase timing helper shared by source_sync, plan, apply, and
// compatibility-check responses. These timings are evidence for user-facing
// "app install" progress without changing the OpenTofu-native execution model.
import type { JsonRecord } from "./types.ts";

export interface RunnerPhaseTiming {
  readonly phase: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export class RunnerPhaseTimer {
  readonly #timings: RunnerPhaseTiming[] = [];

  async measure<T>(phase: string, run: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now();
    try {
      return await run();
    } finally {
      const finishedAtMs = Date.now();
      this.#timings.push({
        phase,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, finishedAtMs - startedAtMs),
      });
    }
  }

  json(): readonly RunnerPhaseTiming[] {
    return this.#timings;
  }
}

export function withPhaseTimings(
  payload: JsonRecord,
  timer: RunnerPhaseTimer,
): JsonRecord {
  const phaseTimings = timer.json();
  return phaseTimings.length > 0 ? { ...payload, phaseTimings } : payload;
}
