import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { CheckCircle2, XCircle } from "lucide-solid";

type Tone = "success" | "error" | "neutral";

interface Props {
  tone?: Tone;
  /** Optional leading icon override (defaults per tone). */
  icon?: JSX.Element;
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
        <span>{props.children}</span>
      </Show>
    </div>
  );
}
