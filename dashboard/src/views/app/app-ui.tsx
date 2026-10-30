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
import { ChevronDown, ExternalLink, Smartphone } from "lucide-solid";
import { Button } from "../../components/ui/index.ts";
import { formatDateTime, relativeTime, t } from "../../i18n/index.ts";
import { type OpenRouteScreen, screenOpenRoute } from "../../lib/open-choice-state.ts";
import type { OpenRoute } from "../../lib/open-routing.ts";

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
  /** An extra class for a section that is also shown outside the app page. */
  readonly class?: string;
}): JSX.Element {
  return (
    <section
      id={props.id}
      class={props.class ? `tg-card ap-section ${props.class}` : "tg-card ap-section"}
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

/** One launchable screen as "Open" shows it: its display name, URL and native clients. */
export interface OpenableScreen extends OpenRouteScreen {
  readonly name?: string;
}

/**
 * The anchor one route opens with. The web opens in a new tab, as on a
 * computer; a native app is a link the person taps in place (a universal
 * link must be tapped, and an `intent:` link leaves the page alone when the
 * app opens); the chooser is a page of the dashboard.
 */
export function openRouteAnchor(route: OpenRoute): { readonly href: string; readonly target?: string; readonly rel?: string } {
  switch (route.kind) {
    case "web":
      return { href: route.href, target: "_blank", rel: "noreferrer noopener" };
    case "native":
      return { href: route.href, rel: "noreferrer" };
    case "choose":
      return { href: route.href };
  }
}

/** The accessible name of a link that opens `name` along `route`. */
export function openRouteAria(route: OpenRoute, name: string): string {
  switch (route.kind) {
    case "web":
      return t("app.open.aria", { name });
    case "native":
      return t("app.open.ariaNative", { name, app: route.client.name ?? t("app.phone.unverifiedName") });
    case "choose":
      return t("app.open.ariaChoose", { name });
  }
}

/**
 * "Open" for an app's screens. One screen is one link; several screens keep
 * the declared primary screen on the button and list every other screen in a
 * menu next to it, so no screen is reachable only through the first one.
 *
 * On a phone each screen opens the way this device chose or the app declares
 * (lib/open-routing.ts): in the browser, in its verified native app, or at
 * the chooser. On a computer every screen opens in a new tab.
 */
export function OpenAppButton(props: {
  readonly surfaces: readonly OpenableScreen[];
  readonly variant?: "primary" | "secondary";
  readonly size?: "sm" | "md";
  /** Shown for an unnamed screen. */
  readonly appName: string;
  /** The app the screens belong to; without it every screen opens on the web. */
  readonly capsuleId?: string;
  /**
   * Called instead of following the chooser link when this page already
   * shows the chooser (the app page).
   */
  readonly onChoose?: (interfaceId: string) => void;
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
  const surfaceName = (surface: OpenableScreen, index: number) =>
    surface.name ||
    (props.surfaces.length > 1
      ? t("app.open.screenN", { n: index + 1 })
      : props.appName);
  const routeOf = (surface: OpenableScreen) => screenOpenRoute(props.capsuleId, surface);
  /** Reads the route at click time: a choice remembered meanwhile applies. */
  const onRouteClick = (event: MouseEvent, surface: OpenableScreen) => {
    setOpen(false);
    if (routeOf(surface).kind === "choose" && props.onChoose && surface.interfaceId) {
      event.preventDefault();
      props.onChoose(surface.interfaceId);
    }
  };
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
      {(surface) => {
        const route = () => routeOf(surface());
        const nativeName = () => {
          const value = route();
          return value.kind === "native" ? value.client.name : undefined;
        };
        return (
          <div class="ap-open" ref={container} onKeyDown={onKeyDown} data-open-route={route().kind}>
            <Button
              variant={props.variant ?? "primary"}
              size={props.size ?? "md"}
              {...openRouteAnchor(route())}
              onClick={(event: MouseEvent) => onRouteClick(event, surface())}
              icon={route().kind === "web" ? <ExternalLink size={16} /> : <Smartphone size={16} />}
              aria-label={
                props.labelWithApp || route().kind !== "web"
                  ? openRouteAria(route(), surfaceName(surface(), 0))
                  : undefined
              }
            >
              <Show when={nativeName()} fallback={t("app.open.cta")}>
                {(name) => t("app.phone.nativeOpen", { name: name() })}
              </Show>
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
                    {(other, index) => {
                      const otherRoute = () => routeOf(other);
                      return (
                        <li role="none">
                          <a
                            role="menuitem"
                            {...openRouteAnchor(otherRoute())}
                            data-open-route={otherRoute().kind}
                            aria-label={openRouteAria(otherRoute(), surfaceName(other, index() + 1))}
                            onClick={(event: MouseEvent) => onRouteClick(event, other)}
                          >
                            {surfaceName(other, index() + 1)}
                          </a>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
