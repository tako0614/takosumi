/**
 * Avatar pill in TopBar: signed-in identity, account link, language switch
 * (EN/JA — persists via i18n setLocale), and sign-out.
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Clock3, HelpCircle, LogOut, UserCircle2 } from "lucide-solid";
import {
  clearSession,
  onSessionChange,
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
import { isTakosEmbeddedRuntime } from "../../../../lib/deployment-brand.ts";

// The Takos embedded shell keeps its external docs site; the standalone
// dashboard links same-origin `/docs/` (the platform worker serves docs on the
// same origin), so a self-hosted or local deployment never points at the
// operator's hosted host.
const docsHref = (): string =>
  isTakosEmbeddedRuntime() ? "https://docs.takos.jp" : "/docs/";

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
  let triggerRef: HTMLButtonElement | undefined;

  onMount(() => {
    // The first readSession() often returns null while /session/me is still
    // inflight; subscribe so displayName/email fill in once it resolves.
    setSession(readSession());
    const unsubscribe = onSessionChange(setSession);
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef) return;
      if (containerRef.contains(e.target as Node)) return;
      if (!open()) return;
      // Check before closing: removing the popup drops focus to <body> when
      // the click landed on a non-focusable surface.
      const focusWasInside = containerRef.contains(document.activeElement);
      setOpen(false);
      if (focusWasInside) triggerRef?.focus();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open()) {
        setOpen(false);
        triggerRef?.focus();
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      unsubscribe();
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  const initial = () => {
    const s = session();
    if (!s) return "?";
    return (s.displayName ?? s.email ?? t("nav.account"))
      .charAt(0)
      .toUpperCase();
  };
  const label = () => {
    const s = session();
    if (!s) return "—";
    return s.displayName ?? s.email ?? t("nav.account");
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
        // No haspopup hint: the popup is a role="group" of links/controls,
        // not a role="menu"; aria-expanded alone matches the real semantics.
        aria-expanded={open()}
        ref={triggerRef}
        onClick={() => setOpen(!open())}
      >
        <span class="topbar-avatar">{initial()}</span>
      </button>
      <Show when={open()}>
        <div
          class="user-menu-pop"
          role="group"
          aria-label={t("shell.userMenu")}
        >
          <div class="user-menu-id">
            <div class="user-menu-name">{label()}</div>
            <Show when={session()?.displayName && session()?.email}>
              {(email) => <div class="user-menu-sub">{email()}</div>}
            </Show>
          </div>
          <a class="user-menu-item" href="/runs" onClick={() => setOpen(false)}>
            <Clock3 size={16} /> {t("nav.runs")}
          </a>
          <div class="user-menu-divider" />
          <a
            class="user-menu-item"
            href="/settings/account"
            onClick={() => setOpen(false)}
          >
            <UserCircle2 size={16} /> {t("nav.account")}
          </a>
          <a
            class="user-menu-item"
            href={docsHref()}
            target="_blank"
            rel="external noopener"
            onClick={() => setOpen(false)}
          >
            <HelpCircle size={16} /> {t("nav.docs")}
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
              aria-pressed={locale() === "ja"}
              onClick={() => setLocale("ja")}
            >
              日本語
            </button>
            <button
              type="button"
              class="user-menu-lang-btn"
              classList={{ active: locale() === "en" }}
              aria-pressed={locale() === "en"}
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
                aria-pressed={themePreference() === theme}
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
