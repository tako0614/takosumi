import { createSignal, onMount, Show } from "solid-js";
import { Monitor, Moon, Sun } from "lucide-solid";

type Mode = "auto" | "light" | "dark";

function readMode(): Mode {
  if (typeof localStorage === "undefined") return "auto";
  const v = localStorage.getItem("tg-theme");
  return v === "light" || v === "dark" ? v : "auto";
}

function apply(mode: Mode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export default function ThemeToggle() {
  const [mode, setMode] = createSignal<Mode>("auto");

  onMount(() => {
    const m = readMode();
    setMode(m);
    apply(m);
  });

  const cycle = () => {
    const next: Mode = mode() === "auto"
      ? "light"
      : mode() === "light"
      ? "dark"
      : "auto";
    setMode(next);
    apply(next);
    if (typeof localStorage !== "undefined") {
      if (next === "auto") localStorage.removeItem("tg-theme");
      else localStorage.setItem("tg-theme", next);
    }
  };

  return (
    <button
      class="topbar-icon-btn"
      type="button"
      onClick={cycle}
      title={`Theme: ${mode()}`}
      aria-label={`Theme: ${mode()}`}
      data-mode={mode()}
    >
      <Show when={mode() === "auto"}>
        <Monitor size={18} />
      </Show>
      <Show when={mode() === "light"}>
        <Sun size={18} />
      </Show>
      <Show when={mode() === "dark"}>
        <Moon size={18} />
      </Show>
    </button>
  );
}
