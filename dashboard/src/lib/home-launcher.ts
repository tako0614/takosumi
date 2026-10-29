/**
 * Home launcher behavior: which tiles open an app, which wait, and their
 * order. Pure so tests can pin it without rendering the view.
 *
 * Every app the person can use or keep gets a tile; nothing is folded away.
 * A tile opens the app's screen only when an authorized screen exists and the
 * app is not installing, being removed or stopped. Every other tile opens the
 * app page. The tiles that cannot be used yet "wait": they are drawn muted
 * with a status mark and sorted after the usable ones.
 */
import { type AppState, appStateRank } from "./app-page.ts";

export interface HomeLauncherApp {
  readonly state: AppState;
  readonly surfaces: readonly unknown[];
}

/** The tile opens the app's first authorized screen in a new tab. */
export function homeAppOpens(app: HomeLauncherApp): boolean {
  return (
    app.surfaces.length > 0 &&
    app.state !== "installing" &&
    app.state !== "uninstalling" &&
    app.state !== "stopped"
  );
}

/**
 * Not usable yet (installing, never applied, failed without a screen, being
 * removed, stopped). An installed app without a screen does not wait: its
 * tile simply opens the app page.
 */
export function homeAppWaiting(app: HomeLauncherApp): boolean {
  return (
    !homeAppOpens(app) &&
    app.state !== "ready" &&
    app.state !== "update_available"
  );
}

/**
 * Usable apps first in name order, like a phone home screen; then the waiting
 * ones, what needs the person first (appStateRank), then name.
 */
export function sortHomeApps<T extends HomeLauncherApp>(
  apps: readonly T[],
  nameOf: (app: T) => string,
  locale: string,
): T[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  return [...apps].sort((a, b) => {
    const aWaits = homeAppWaiting(a);
    const waiting = Number(aWaits) - Number(homeAppWaiting(b));
    if (waiting !== 0) return waiting;
    if (aWaits) {
      const rank = appStateRank(a.state) - appStateRank(b.state);
      if (rank !== 0) return rank;
    }
    return collator.compare(nameOf(a), nameOf(b));
  });
}
