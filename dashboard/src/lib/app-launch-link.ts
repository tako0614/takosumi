import { t } from "../i18n/index.ts";
import { clientTargetLabel, type OpenRoute } from "./open-routing.ts";

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
      // A native route is always a verified client, which always has a name.
      return t("app.open.ariaNative", {
        name,
        app: route.client.name ?? t("app.phone.unverifiedName", { target: clientTargetLabel(route.client) }),
      });
    case "choose":
      return t("app.open.ariaChoose", { name });
  }
}
