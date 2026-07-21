import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { CheckCircle2, X, XCircle } from "lucide-solid";
import { t } from "../../i18n/index.ts";

type Tone = "success" | "error" | "neutral";

interface Props {
  tone?: Tone;
  /** Optional leading icon override (defaults per tone). */
  icon?: JSX.Element;
  /**
   * Render a dismiss control. Despite the name this is an INLINE banner with
   * no lifecycle of its own, so a success note used to stay pinned for the rest
   * of the session — including after the user edited the field again.
   */
  onDismiss?: () => void;
  children: JSX.Element;
}

const TONE_CLASS: Record<Tone, string> = {
  success: "tg-toast-success",
  error: "tg-toast-error",
  neutral: "",
};

/** Inline action-feedback banner (success / error / neutral). */
export default function Toast(props: Props): JSX.Element {
  const tone = () => props.tone ?? "neutral";
  // Live regions only announce text that changes INSIDE an already-mounted
  // region; call sites mount Toast conditionally (<Show>), which inserts the
  // region together with its content. Mount the region empty first and inject
  // the content on a later task so screen readers actually announce it. A
  // microtask can still coalesce with the mount in the same paint for some AT;
  // a macrotask (setTimeout 0) guarantees a separate mutation.
  const [announce, setAnnounce] = createSignal(false);
  onMount(() => {
    const id = setTimeout(() => setAnnounce(true), 0);
    onCleanup(() => clearTimeout(id));
  });
  return (
    <div
      class={`tg-toast ${TONE_CLASS[tone()]}`}
      role={tone() === "error" ? "alert" : "status"}
    >
      <Show when={announce()}>
        <Show
          when={props.icon}
          fallback={
            <Show when={tone() !== "neutral"}>
              <span aria-hidden="true" style="display:inline-flex">
                <Show
                  when={tone() === "success"}
                  fallback={<XCircle size={16} />}
                >
                  <CheckCircle2 size={16} />
                </Show>
              </span>
            </Show>
          }
        >
          <span aria-hidden="true" style="display:inline-flex">
            {props.icon}
          </span>
        </Show>
        <span class="tg-toast-body">{props.children}</span>
        <Show when={props.onDismiss}>
          {(dismiss) => (
            <button
              type="button"
              class="tg-toast-dismiss"
              aria-label={t("common.dismiss")}
              onClick={() => dismiss()()}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </Show>
      </Show>
    </div>
  );
}
