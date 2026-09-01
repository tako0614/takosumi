// runner/lib/apply_progress.ts
//
// Live apply/destroy progress for the install experience.
//
// An install used to show one status-only spinner for the whole apply, which
// is the slowest part of adding a service and the part a user is most likely
// to abandon. OpenTofu already narrates its own work on stdout; this module
// reads that narration as it streams and keeps a per-run counter the control
// plane can poll, so the dashboard can say "creating resources (3 of 7)".
//
// Deliberately parsed from the HUMAN output rather than `-json`: switching the
// apply command to `-json` would change the exact stdout that error
// classification, redaction, and the user-visible run log all consume. The
// lines matched below are OpenTofu's long-stable progress vocabulary, and a
// parse that matches nothing simply reports no progress — never a wrong count
// and never a behavior change.

/** One run's live progress while its apply/destroy executes. */
export interface ApplyProgress {
  /** Resources whose create/update/destroy finished. */
  readonly completed: number;
  /**
   * Resources OpenTofu has started but not finished. Useful for "still
   * working" without implying completion.
   */
  readonly inFlight: number;
  /** Most recent resource address OpenTofu reported work on, if any. */
  readonly currentResource?: string;
}

const STARTED_PATTERN =
  /^\s*(\S+?):\s+(?:Creating|Modifying|Destroying|Reading|Refreshing state)\.\.\./u;
const COMPLETED_PATTERN =
  /^\s*(\S+?):\s+(?:Creation|Modifications|Destruction|Read|Refresh) complete\b/u;

/**
 * Accumulates progress from streamed stdout. Chunk boundaries do not align
 * with lines, so a partial trailing line is held until the rest arrives.
 */
export class ApplyProgressTracker {
  #completedAddresses = new Set<string>();
  #startedAddresses = new Set<string>();
  #currentResource: string | undefined;
  #pending = "";

  push(chunk: string): void {
    this.#pending += chunk;
    const lines = this.#pending.split("\n");
    // The last element is either "" (chunk ended on a newline) or a partial
    // line; either way it is not ready to parse.
    this.#pending = lines.pop() ?? "";
    for (const line of lines) this.#line(line);
  }

  /** Flushes a trailing line that never received its newline. */
  finish(): void {
    if (this.#pending.length === 0) return;
    const line = this.#pending;
    this.#pending = "";
    this.#line(line);
  }

  progress(): ApplyProgress {
    // Addresses are tracked as sets: OpenTofu re-narrates a slow resource with
    // periodic "Still creating..." lines, and counting those would inflate the
    // total past the plan's real resource count.
    const completed = this.#completedAddresses.size;
    let inFlight = 0;
    for (const address of this.#startedAddresses) {
      if (!this.#completedAddresses.has(address)) inFlight += 1;
    }
    return {
      completed,
      inFlight,
      ...(this.#currentResource ? { currentResource: this.#currentResource } : {}),
    };
  }

  #line(line: string): void {
    const completed = COMPLETED_PATTERN.exec(line);
    if (completed?.[1]) {
      const address = normalizeAddress(completed[1]);
      this.#completedAddresses.add(address);
      this.#startedAddresses.add(address);
      this.#currentResource = address;
      return;
    }
    const started = STARTED_PATTERN.exec(line);
    if (started?.[1]) {
      const address = normalizeAddress(started[1]);
      this.#startedAddresses.add(address);
      this.#currentResource = address;
    }
  }
}

/** Strips the trailing colon OpenTofu prints after a resource address. */
function normalizeAddress(raw: string): string {
  return raw.endsWith(":") ? raw.slice(0, -1) : raw;
}

// --- Per-run registry ------------------------------------------------------
//
// The container serves the progress read on a SEPARATE HTTP request while the
// apply is still blocking its own request, so the tracker has to live outside
// either handler. Entries are removed when the run finishes; a crashed run's
// entry is bounded by the cap below rather than by a timer, because the
// container is torn down with the run anyway.

const MAX_TRACKED_RUNS = 64;
const trackers = new Map<string, ApplyProgressTracker>();

export function beginApplyProgress(runId: string): ApplyProgressTracker {
  if (trackers.size >= MAX_TRACKED_RUNS) {
    // Drop the oldest entry: Map preserves insertion order.
    const oldest = trackers.keys().next();
    if (!oldest.done) trackers.delete(oldest.value);
  }
  const tracker = new ApplyProgressTracker();
  trackers.set(runId, tracker);
  return tracker;
}

export function readApplyProgress(runId: string): ApplyProgress | undefined {
  return trackers.get(runId)?.progress();
}

export function endApplyProgress(runId: string): void {
  trackers.delete(runId);
}
