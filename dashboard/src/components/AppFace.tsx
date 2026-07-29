/**
 * The one renderer for an app's face: icon image → emoji → monogram.
 *
 * Only the class names are per-host, so the store grid keeps its standalone
 * `.tcs-*` styling and the launcher keeps its kind-tinted `.av-tile-*` one
 * while both get the same fallback chain — and the same two guarantees the
 * launcher had alone: a broken icon URL falls back instead of rendering a
 * broken image, and a third-party icon host never receives the dashboard URL
 * (which carries workspace and run ids) as a Referer.
 */
import {
  createEffect,
  createSignal,
  Match,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { appMonogram } from "../lib/app-face.ts";

export interface AppFaceProps {
  /** Used for the monogram when there is no image or emoji. */
  readonly name: string;
  /** Absolute icon URL. Repo/Interface-supplied, so treated as untrusted. */
  readonly iconUrl?: string | undefined;
  readonly emoji?: string | undefined;
  /** Class on the frame element. */
  readonly class?: string;
  /** Extra frame class applied ONLY while the image is the face. */
  readonly imageFrameClass?: string;
  /** Extra frame class applied ONLY while the monogram is the face. */
  readonly monogramFrameClass?: string;
  readonly imageClass?: string;
  readonly emojiClass?: string;
  readonly monogramClass?: string;
  /** Rendered instead of the monogram (e.g. a kind glyph). */
  readonly fallback?: JSX.Element;
  /** Overlay inside the frame (e.g. the needs-attention dot). */
  readonly children?: JSX.Element;
}

export default function AppFace(props: AppFaceProps): JSX.Element {
  const [imageFailed, setImageFailed] = createSignal(false);
  // Reset on a new URL: a face that failed once must not stay failed when the
  // screen swaps in a different app.
  createEffect(() => {
    void props.iconUrl;
    setImageFailed(false);
  });
  const imageSrc = () => {
    const url = props.iconUrl;
    return url && !imageFailed() ? url : undefined;
  };
  const showsMonogram = () => !imageSrc() && !props.emoji;
  const frameClass = () =>
    [
      props.class,
      imageSrc() ? props.imageFrameClass : undefined,
      showsMonogram() ? props.monogramFrameClass : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  return (
    <span class={frameClass()} aria-hidden="true">
      <Switch
        fallback={
          <Show when={!props.fallback} fallback={<>{props.fallback}</>}>
            <span class={props.monogramClass}>{appMonogram(props.name)}</span>
          </Show>
        }
      >
        <Match when={imageSrc()}>
          {(src) => (
            <img
              class={props.imageClass}
              src={src()}
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              onError={() => setImageFailed(true)}
            />
          )}
        </Match>
        <Match when={props.emoji}>
          {(emo) => <span class={props.emojiClass}>{emo()}</span>}
        </Match>
      </Switch>
      {props.children}
    </span>
  );
}
