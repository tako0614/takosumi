/**
 * run-tone — Wave A local Run-status → Badge `Tone` mapping.
 *
 * The shared status-labels.ts maps Run status onto legacy `.status-*` modifier
 * classes; the new StatusBadge wants a token-driven `Tone`. This keeps the
 * enum→tone switch in one place for the Wave A control-flow views (Run /
 * RunGroup) without touching the shared status-labels module.
 *
 * Run status enum (spec §19): queued / running / waiting_approval / succeeded /
 * failed / cancelled / expired.
 */
import type { Tone } from "../../components/ui/Badge.tsx";

export function runTone(status: string | undefined): Tone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "running":
    case "queued":
    case "waiting_approval":
      return "warn";
    case "failed":
    case "expired":
      return "danger";
    case "cancelled":
      return "muted";
    default:
      return "neutral";
  }
}

/** Run policy status (spec §25): pass / warn / deny. */
export function policyTone(status: string | undefined): Tone {
  switch (status) {
    case "pass":
      return "ok";
    case "warn":
      return "warn";
    case "deny":
      return "danger";
    default:
      return "muted";
  }
}

/** Deployment status (spec §21): active / superseded / rolled_back / destroyed. */
export function deploymentTone(status: string | undefined): Tone {
  switch (status) {
    case "active":
      return "ok";
    case "superseded":
    case "rolled_back":
    case "destroyed":
      return "muted";
    default:
      return "neutral";
  }
}

/** Installation status (spec §5). */
export function installationTone(status: string | undefined): Tone {
  switch (status) {
    case "active":
      return "ok";
    case "pending":
    case "stale":
      return "warn";
    case "error":
      return "danger";
    case "disabled":
    case "destroyed":
      return "muted";
    default:
      return "neutral";
  }
}
