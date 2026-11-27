import { Loader2 } from "lucide-solid";
import { t } from "../../i18n/index.ts";
import type { JSX } from "solid-js";

interface Props {
  size?: number;
  class?: string;
  /** Accessible label (defaults to a generic loading announcement). */
  label?: string;
  /** True when adjacent text inside a live region already announces loading. */
  decorative?: boolean;
}

/** Spinning loader icon (lucide Loader2 + CSS rotation via `.tg-spinner`). */
export default function Spinner(props: Props): JSX.Element {
  return (
    <span
      class={`tg-spinner ${props.class ?? ""}`}
      role={props.decorative ? undefined : "status"}
      aria-label={props.decorative ? undefined : (props.label ?? t("common.loading"))}
      aria-hidden={props.decorative ? "true" : undefined}
    >
      <Loader2 size={props.size ?? 18} aria-hidden="true" />
    </span>
  );
}
