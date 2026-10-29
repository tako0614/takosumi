import { describe, expect, test } from "bun:test";
import type { AppState } from "../../../../dashboard/src/lib/app-page.ts";
import {
  homeAppOpens,
  homeAppWaiting,
  sortHomeApps,
} from "../../../../dashboard/src/lib/home-launcher.ts";

interface Row {
  readonly name: string;
  readonly state: AppState;
  readonly surfaces: readonly { readonly url: string }[];
}

const screen = [{ url: "https://app.example.test/" }];
const row = (name: string, state: AppState, withScreen = false): Row => ({
  name,
  state,
  surfaces: withScreen ? screen : [],
});

describe("Home launcher tiles", () => {
  test("a tile opens the app only with an authorized screen and a usable state", () => {
    expect(homeAppOpens(row("Office", "ready", true))).toBe(true);
    expect(homeAppOpens(row("Blog", "update_available", true))).toBe(true);
    // A failed apply keeps the previous screen usable.
    expect(homeAppOpens(row("Mail", "needs_attention", true))).toBe(true);
    for (const state of ["installing", "uninstalling", "stopped"] as const) {
      expect(homeAppOpens(row("App", state, true)), state).toBe(false);
    }
    expect(homeAppOpens(row("Storage", "ready"))).toBe(false);
  });

  test("apps that cannot be used yet wait; an installed app without a screen does not", () => {
    for (const state of ["installing", "needs_attention", "uninstalling", "stopped"] as const) {
      expect(homeAppWaiting(row("App", state)), state).toBe(true);
    }
    expect(homeAppWaiting(row("Storage", "ready"))).toBe(false);
    expect(homeAppWaiting(row("Blog", "update_available"))).toBe(false);
    expect(homeAppWaiting(row("Mail", "needs_attention", true))).toBe(false);
  });

  test("usable apps come first in name order, then waiting apps by what needs the person", () => {
    const apps = [
      row("Old Wiki", "uninstalling", true),
      row("chat", "installing", true),
      row("Zeta", "ready", true),
      row("Mail Relay", "needs_attention"),
      row("Object Storage", "stopped"),
      row("Team Blog", "update_available"),
      row("alpha", "ready", true),
      row("Broken Draft", "needs_attention"),
      row("Files", "ready"),
    ];
    const sorted = sortHomeApps(apps, (app) => app.name, "en");
    expect(sorted.map((app) => app.name)).toEqual([
      "alpha",
      "Files",
      "Team Blog",
      "Zeta",
      "Broken Draft",
      "Mail Relay",
      "chat",
      "Old Wiki",
      "Object Storage",
    ]);
    // Sorting never drops or folds away an app, and leaves the input alone.
    expect(sorted).toHaveLength(apps.length);
    expect(apps[0]!.name).toBe("Old Wiki");
  });
});
