/**
 * Small building blocks shared by the installed-app page sections and Home.
 */
import {
  createEffect,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js";
import { ChevronDown, ExternalLink } from "lucide-solid";
import { Button } from "../../components/ui/index.ts";
import { formatDateTime, relativeTime, t } from "../../i18n/index.ts";
import type { AuthorizedUiSurface } from "../../lib/ui-surface-interfaces.ts";

/** Relative time ("5分前"), with the exact date and time on hover. */
export function RelativeTime(props: { readonly iso: string }): JSX.Element {
  return (
    <time datetime={props.iso} title={formatDateTime(props.iso)}>
      {relativeTime(props.iso)}
    </time>
  );
}

/** One behavior section of the app page: a card with a real heading. */
export function AppSection(props: {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: JSX.Element;
  readonly children: JSX.Element;
  readonly testId?: string;
}): JSX.Element {
  return (
    <section
      id={props.id}
      class="tg-card ap-section"
      aria-labelledby={`${props.id}-title`}
      data-testid={props.testId}
    >
      <div class="ap-section-head">
        <div>
          <h2 id={`${props.id}-title`}>{props.title}</h2>
          <Show when={props.subtitle}>
            <p>{props.subtitle}</p>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="ap-section-actions">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

/**
 * "Open" for an app's screens. One screen is one link; several screens keep
 * the declared primary screen on the button and list every other screen in a
 * menu next to it, so no screen is reachable only through the first one.
 */
export function OpenAppButton(props: {
  readonly surfaces: readonly AuthorizedUiSurface[];
  readonly variant?: "primary" | "secondary";
  readonly size?: "sm" | "md";
  /** Shown for an unnamed screen. */
  readonly appName: string;
  /**
   * Names the app in the accessible label where several apps' Open buttons
   * sit side by side (Home). On the app page the visible text is enough.
   */
  readonly labelWithApp?: boolean;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  let container: HTMLDivElement | undefined;
  const primary = () => props.surfaces[0];
  const others = () => props.surfaces.slice(1);
  const surfaceName = (surface: AuthorizedUiSurface, index: number) =>
    surface.name ||
    (props.surfaces.length > 1
      ? t("app.open.screenN", { n: index + 1 })
      : props.appName);
  const onDocumentClick = (event: MouseEvent) => {
    if (container && !container.contains(event.target as Node)) setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && open()) {
      event.stopPropagation();
      setOpen(false);
      container?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    }
  };
  createEffect(() => {
    if (!open()) return;
    document.addEventListener("click", onDocumentClick);
    onCleanup(() => document.removeEventListener("click", onDocumentClick));
  });
  return (
    <Show when={primary()}>
      {(surface) => (
        <div class="ap-open" ref={container} onKeyDown={onKeyDown}>
          <Button
            variant={props.variant ?? "primary"}
            size={props.size ?? "md"}
            href={surface().url}
            target="_blank"
            rel="noreferrer noopener"
            icon={<ExternalLink size={16} />}
            aria-label={
              props.labelWithApp
                ? t("app.open.aria", { name: surfaceName(surface(), 0) })
                : undefined
            }
          >
            {t("app.open.cta")}
            <Show when={props.surfaces.length > 1}>
              <span class="ap-open-name">{surfaceName(surface(), 0)}</span>
            </Show>
          </Button>
          <Show when={others().length > 0}>
            <Button
              variant={props.variant ?? "primary"}
              size={props.size ?? "md"}
              class="ap-open-toggle"
              type="button"
              aria-haspopup="menu"
              aria-expanded={open()}
              aria-label={t("app.open.more")}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </Button>
            <Show when={open()}>
              <ul class="ap-open-menu" role="menu">
                <For each={others()}>
                  {(other, index) => (
                    <li role="none">
                      <a
                        role="menuitem"
                        href={other.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={t("app.open.aria", {
                          name: surfaceName(other, index() + 1),
                        })}
                        onClick={() => setOpen(false)}
                      >
                        {surfaceName(other, index() + 1)}
                      </a>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </div>
      )}
    </Show>
  );
}
