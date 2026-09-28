import { createSignal, onCleanup, onMount } from "solid-js";

const THEME_KEY = "takosumi-site-theme";
type Theme = "light" | "dark";

function readSavedTheme(): Theme | undefined {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : undefined;
  } catch {
    return undefined;
  }
}

function systemTheme(media: MediaQueryList): Theme {
  return media.matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "dark" ? "#0a0a0b" : "#f7f7f8",
  );
}

export default function ThemeToggle() {
  const [mounted, setMounted] = createSignal(false);
  const [isDark, setIsDark] = createSignal(false);

  onMount(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let manuallySet = readSavedTheme() !== undefined;

    const saved = readSavedTheme();
    const bootstrapped = root.dataset.theme;
    const initial = saved ?? (bootstrapped === "light" || bootstrapped === "dark"
      ? bootstrapped
      : systemTheme(media));
    applyTheme(initial);
    setIsDark(initial === "dark");
    setMounted(true);

    const onSystemChange = () => {
      if (!manuallySet) {
        const theme = systemTheme(media);
        applyTheme(theme);
        setIsDark(theme === "dark");
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY && event.key !== null) return;
      const next = readSavedTheme();
      manuallySet = next !== undefined;
      const theme = next ?? systemTheme(media);
      applyTheme(theme);
      setIsDark(theme === "dark");
    };

    const onClick = () => {
      const theme: Theme = isDark() ? "light" : "dark";
      manuallySet = true;
      applyTheme(theme);
      setIsDark(theme === "dark");
      try {
        window.localStorage.setItem(THEME_KEY, theme);
      } catch {
        // The visual toggle still works when browser storage is unavailable.
      }
    };

    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    toggleButton.addEventListener("click", onClick);

    onCleanup(() => {
      media.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
      toggleButton.removeEventListener("click", onClick);
    });
  });

  let toggleButton!: HTMLButtonElement;

  return (
    <button
      ref={toggleButton}
      class="theme-toggle"
      type="button"
      aria-label="ダークモード"
      aria-pressed={isDark()}
      title={isDark() ? "ライトモードに切り替え" : "ダークモードに切り替え"}
      disabled={!mounted()}
    >
      <svg class="theme-toggle-moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8 8.6 8.6 0 1 0 20.2 15.2Z" />
      </svg>
      <svg class="theme-toggle-sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
      </svg>
    </button>
  );
}
