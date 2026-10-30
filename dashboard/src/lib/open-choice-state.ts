/**
 * The browser side of `open-routing.ts`: this device's platform, the choices
 * it remembered (in `localStorage`, read and written inside try/catch), and
 * the route one tap on a screen takes. Remembering or forgetting a choice
 * bumps a signal so every Open on the page follows at once.
 *
 * Without storage (private mode, blocked site data) nothing is remembered and
 * every tap uses the default again; nothing here throws.
 */
import { createSignal } from "solid-js";
import {
  appOpenChooserPath,
  detectOpenPlatform,
  forgetOpenChoice,
  type OpenChoiceStorage,
  type OpenPlatform,
  type OpenRoute,
  openChoiceStorageWorks,
  readOpenChoice,
  type RememberedOpenChoice,
  resolveOpenRoute,
  writeOpenChoice,
} from "./open-routing.ts";

const [revision, setRevision] = createSignal(0);
const bump = () => setRevision((value) => value + 1);

if (typeof window !== "undefined") {
  // Another tab remembered or forgot a choice.
  window.addEventListener("storage", bump);
}

function storage(): OpenChoiceStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Reading `localStorage` itself throws where site data is blocked.
    return undefined;
  }
}

let platform: OpenPlatform | undefined;

/** The platform this page runs on, detected once. */
export function currentOpenPlatform(): OpenPlatform {
  if (platform !== undefined) return platform;
  if (typeof navigator === "undefined") return (platform = "desktop");
  const hints = (navigator as Navigator & { readonly userAgentData?: { readonly platform?: unknown } }).userAgentData;
  platform = detectOpenPlatform({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    ...(typeof hints?.platform === "string" ? { clientHintPlatform: hints.platform } : {}),
  });
  return platform;
}

/** This device's remembered choice for one app's screen (reactive). */
export function rememberedOpenChoice(capsuleId: string, interfaceId: string): RememberedOpenChoice | undefined {
  revision();
  return readOpenChoice(storage(), capsuleId, interfaceId);
}

/** Remember a choice; false when the browser refuses to keep it. */
export function rememberOpenChoice(capsuleId: string, interfaceId: string, choice: RememberedOpenChoice): boolean {
  const kept = writeOpenChoice(storage(), capsuleId, interfaceId, choice);
  bump();
  return kept;
}

/** Forget the choice; false when the browser refuses. */
export function forgetRememberedOpenChoice(capsuleId: string, interfaceId: string): boolean {
  const done = forgetOpenChoice(storage(), capsuleId, interfaceId);
  bump();
  return done;
}

/** Whether this browser can remember a choice at all (reactive). */
export function openChoiceStorageAvailable(): boolean {
  revision();
  return openChoiceStorageWorks(storage());
}

/** Android's `S.browser_fallback_url`: this screen's chooser, marked as "did not open". */
export function openChooserFallbackUrl(capsuleId: string, interfaceId: string): string | undefined {
  if (typeof location === "undefined") return undefined;
  try {
    return new URL(appOpenChooserPath(capsuleId, interfaceId, { missing: true }), location.origin).href;
  } catch {
    return undefined;
  }
}

/** One launchable screen as Open sees it. */
export interface OpenRouteScreen {
  readonly url: string;
  readonly interfaceId?: string;
  readonly clients?: unknown;
}

/**
 * How one tap opens `screen` here (reactive to remembered choices). Without
 * the app and screen ids there is no chooser to fall back to, so it is the
 * web.
 */
export function screenOpenRoute(capsuleId: string | undefined, screen: OpenRouteScreen): OpenRoute {
  const devicePlatform = currentOpenPlatform();
  if (!capsuleId || !screen.interfaceId || devicePlatform === "desktop") {
    return { kind: "web", href: screen.url };
  }
  const fallbackUrl = openChooserFallbackUrl(capsuleId, screen.interfaceId);
  const remembered = rememberedOpenChoice(capsuleId, screen.interfaceId);
  return resolveOpenRoute({
    platform: devicePlatform,
    url: screen.url,
    clients: screen.clients,
    ...(remembered ? { remembered } : {}),
    chooserHref: appOpenChooserPath(capsuleId, screen.interfaceId),
    ...(fallbackUrl ? { fallbackUrl } : {}),
  });
}
