/**
 * Avatar pill in TopBar: signed-in identity, account link, language switch
 * (EN/JA — persists via i18n setLocale), and sign-out.
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { CreditCard, LogOut, UserCircle2 } from "lucide-solid";
import {
  clearSession,
  readSession,
  type SessionRecord,
} from "../../lib/session.ts";
import { locale, setLocale, t } from "../../../../i18n/index.ts";
import type { MessageKey } from "../../../../i18n/index.ts";
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from "../../../../lib/theme.ts";

const THEME_LABEL_KEY: Record<ThemePreference, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

export default function UserMenu() {
  const [open, setOpen] = createSignal(false);
  const [session, setSession] = createSignal<SessionRecord | null>(null);
  const nav = useNavigate();
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    setSession(readSession());
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef) return;
      if (!containerRef.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    onCleanup(() => document.removeEventListener("click", onDocClick));
  });

  const initial = () => {
    const s = session();
    if (!s) return "?";
    return (s.displayName ?? s.email ?? s.subject ?? "?")
      .charAt(0)
      .toUpperCase();
  };
  const label = () => {
    const s = session();
    if (!s) return "—";
    return s.displayName ?? s.email ?? s.subject;
  };

  const signOut = () => {
    clearSession();
    nav("/sign-in", { replace: true });
  };

  return (
    <div class="user-menu" ref={containerRef}>
      <button
        type="button"
        class="topbar-user"
        aria-label={t("shell.userMenu")}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <span class="topbar-avatar">{initial()}</span>
      </button>
      <Show when={open()}>
        <div class="user-menu-pop" role="menu">
          <div class="user-menu-id">
            <div class="user-menu-name">{label()}</div>
            <Show when={session()?.subject}>
              {(sub) => <div class="user-menu-sub">{sub()}</div>}
            </Show>
          </div>
          <a
            class="user-menu-item"
            href="/account"
            onClick={() => setOpen(false)}
          >
            <UserCircle2 size={16} /> {t("nav.account")}
          </a>
          <a
            class="user-menu-item"
            href="/billing"
            onClick={() => setOpen(false)}
          >
            <CreditCard size={16} /> {t("nav.billing")}
          </a>
          <div
            class="user-menu-lang"
            role="group"
            aria-label={t("shell.language")}
          >
            <span class="user-menu-lang-label">{t("shell.language")}</span>
            <button
              type="button"
              class="user-menu-lang-btn"
              classList={{ active: locale() === "ja" }}
              onClick={() => setLocale("ja")}
            >
              日本語
            </button>
            <button
              type="button"
              class="user-menu-lang-btn"
              classList={{ active: locale() === "en" }}
              onClick={() => setLocale("en")}
            >
              English
            </button>
          </div>
          <div
            class="user-menu-lang"
            role="group"
            aria-label={t("shell.theme")}
          >
            <span class="user-menu-lang-label">{t("shell.theme")}</span>
            {(["system", "light", "dark"] as const).map((theme) => (
              <button
                type="button"
                class="user-menu-lang-btn"
                classList={{ active: themePreference() === theme }}
                onClick={() => setThemePreference(theme)}
              >
                {t(THEME_LABEL_KEY[theme])}
              </button>
            ))}
          </div>
          <button
            class="user-menu-item user-menu-danger"
            type="button"
            onClick={signOut}
          >
            <LogOut size={16} /> {t("shell.signOut")}
          </button>
        </div>
      </Show>
    </div>
  );
}
