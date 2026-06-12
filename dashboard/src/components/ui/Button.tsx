import { type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Loader2 } from "lucide-solid";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface Props extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Full-width button. */
  block?: boolean;
  /** Show a spinner and disable interaction. */
  busy?: boolean;
  /** Leading icon (a lucide icon element). */
  icon?: JSX.Element;
  /** Render as an anchor when an href is given (keeps button styling). */
  href?: string;
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary: "tg-btn-primary",
  secondary: "tg-btn-secondary",
  ghost: "tg-btn-ghost",
  danger: "tg-btn-danger",
};

const SIZE_CLASS: Record<Size, string> = {
  sm: "tg-btn-sm",
  md: "",
  lg: "tg-btn-lg",
};

/**
 * Unified button. Variants (primary/secondary/ghost/danger), sizes (sm/md/lg),
 * optional `block`, leading `icon`, and a `busy` spinner. Renders as <a> when
 * `href` is set so it can be used as a styled link.
 */
export default function Button(props: Props): JSX.Element {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "block",
    "busy",
    "icon",
    "href",
    "class",
    "children",
    "disabled",
  ]);
  const cls = () =>
    [
      "tg-btn",
      VARIANT_CLASS[local.variant ?? "secondary"],
      SIZE_CLASS[local.size ?? "md"],
      local.block ? "tg-btn-block" : "",
      local.class ?? "",
    ]
      .filter(Boolean)
      .join(" ");

  const inner = (
    <>
      <Show when={local.busy}>
        <span class="tg-btn-spinner" aria-hidden="true">
          <Loader2 size={16} />
        </span>
      </Show>
      <Show when={!local.busy && local.icon}>
        <span aria-hidden="true" style="display:inline-flex">{local.icon}</span>
      </Show>
      {local.children}
    </>
  );

  return (
    <Show
      when={local.href !== undefined}
      fallback={
        <button
          {...(rest as JSX.ButtonHTMLAttributes<HTMLButtonElement>)}
          class={cls()}
          disabled={local.disabled || local.busy}
          aria-busy={local.busy ? "true" : undefined}
        >
          {inner}
        </button>
      }
    >
      <Dynamic
        component="a"
        {...(rest as Record<string, unknown>)}
        href={local.href}
        class={cls()}
        aria-disabled={local.disabled || local.busy ? "true" : undefined}
      >
        {inner}
      </Dynamic>
    </Show>
  );
}
