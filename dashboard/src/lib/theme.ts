import { createSignal } from "solid-js";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "tg_theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function readPreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

const [themePreference, setThemePreferenceSignal] =
  createSignal<ThemePreference>(readPreference());
const [resolvedTheme, setResolvedTheme] = createSignal<ResolvedTheme>(
  resolveTheme(themePreference()),
);

function applyTheme(preference: ThemePreference, resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  const themeColor = document.querySelector<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (themeColor) {
    themeColor.content = resolved === "dark" ? "#101316" : "#f6f7f9";
  }
}

export function setThemePreference(next: ThemePreference): void {
  setThemePreferenceSignal(next);
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, next);
  }
  const resolved = resolveTheme(next);
  setResolvedTheme(resolved);
  applyTheme(next, resolved);
}

export { resolvedTheme, themePreference };

applyTheme(themePreference(), resolvedTheme());

if (typeof window !== "undefined" && window.matchMedia) {
  const media = window.matchMedia(DARK_QUERY);
  const onSystemThemeChange = () => {
    if (themePreference() !== "system") return;
    const next = systemTheme();
    setResolvedTheme(next);
    applyTheme("system", next);
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onSystemThemeChange);
  } else {
    media.addListener?.(onSystemThemeChange);
  }
}
