import { installationStatusLabel } from "../../../lib/status-labels.ts";

interface Props {
  status?: string;
  class?: string;
}

/**
 * App ("Installation") status pill. Labels come from the shared
 * status-label map (`lib/status-labels.ts`) so the App-vocabulary wording is
 * defined once and reused by later screens. The `status-${s()}` class still
 * keys off the raw status string for styling.
 */
export default function AppStatusPill(props: Props) {
  const s = () => props.status ?? "unknown";
  return (
    <span class={`status-pill status-${s()} ${props.class ?? ""}`}>
      {installationStatusLabel(props.status)}
    </span>
  );
}
