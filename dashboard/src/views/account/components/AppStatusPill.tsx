import { installationStatusLabel } from "../../../lib/status-labels.ts";
import { StatusBadge, type Tone } from "../../../components/ui/index.ts";

interface Props {
  status?: string;
  class?: string;
}

/**
 * Installation ("App") status → ui Badge tone. Maps the canonical
 * `installing` / `ready` / `failed` / `suspended` / `exported` enum onto the
 * shared Badge tone scale. Exported so AppCard and detail views share one tone
 * source. (The legacy `lib/status-labels.ts` only owns labels, not tones.)
 */
export function installationStatusTone(status: string | undefined): Tone {
  switch (status) {
    case "ready":
      return "ok";
    case "installing":
      return "info";
    case "failed":
      return "danger";
    case "suspended":
      return "warn";
    case "exported":
      return "muted";
    default:
      return "neutral";
  }
}

/**
 * App ("Installation") status pill. Now a thin wrapper over the shared
 * {@link StatusBadge}: labels still come from the shared status-label map and
 * the tone from {@link installationStatusTone}, so the App-vocabulary wording
 * and colour treatment are defined once and reused by later screens. Kept as a
 * named default export — other waves may still import it.
 */
export default function AppStatusPill(props: Props) {
  return (
    <StatusBadge
      status={props.status}
      label={installationStatusLabel}
      tone={installationStatusTone}
      class={props.class}
    />
  );
}
