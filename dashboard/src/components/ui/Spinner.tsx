import { Loader2 } from "lucide-solid";
import { t } from "../../i18n/index.ts";
import type { JSX } from "solid-js";

interface Props {
  size?: number;
  class?: string;
  /** Accessible label (defaults to a generic loading announcement). */
  label?: string;
}

/** Spinning loader icon (lucide Loader2 + CSS rotation via `.tg-spinner`). */
export default function Spinner(props: Props): JSX.Element {
  return (
    <span
      class={`tg-spinner ${props.class ?? ""}`}
      role="status"
      aria-label={props.label ?? t("common.loading")}
    >
      <Loader2 size={props.size ?? 18} />
    </span>
  );
}
