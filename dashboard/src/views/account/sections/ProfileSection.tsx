/** Profile, browser preferences, and the current device's sign-out. */
import { createResource, createSignal, For, Show, type JSX } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ExternalLink } from "lucide-solid";
import { readSharedAccountProfile, signOutSession, type SessionRecord } from "../lib/session.ts";
import SignInMethodsCard from "../components/SignInMethodsCard.tsx";
import { intlLocale, locale, setLocale, t } from "../../../i18n/index.ts";
import type { MessageKey } from "../../../i18n/index.ts";
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from "../../../lib/theme.ts";
import {
  installHandlerRegistered,
  installHandlerSupported,
  registerInstallHandler,
} from "../../../lib/install-handler.ts";
import {
  loadPlatformContributions,
  platformContributionDescription,
  platformContributionLabel,
  platformContributionsForSlot,
} from "../../../lib/platform-contributions.ts";
import { currentWorkspaceId } from "../../../lib/workspace-state.ts";
import { isKnownSharedAuthRoutePresent } from "../../../lib/shared-auth-session-preflight.ts";
import { Button, Select } from "../../../components/ui/index.ts";

const THEME_LABEL_KEY: Record<ThemePreference, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};
const THEMES = ["system", "light", "dark"] as const;

function contributionHref(href: string): string {
  const workspaceId = currentWorkspaceId();
  if (!workspaceId) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
}

export default function ProfileSection(props: {
  readonly session: SessionRecord;
  readonly children?: JSX.Element;
}) {
  const nav = useNavigate();
  let signOutAction!: HTMLButtonElement;
  let cancelSignOut!: HTMLButtonElement;
  const [signingOut, setSigningOut] = createSignal(false);
  const [confirmingSignOut, setConfirmingSignOut] = createSignal(false);
  const [signOutUnavailable, setSignOutUnavailable] = createSignal(false);
  const installHandlerAvailable = installHandlerSupported();
  const [handlerRegistered, setHandlerRegistered] = createSignal(
    installHandlerRegistered(),
  );
  const [handlerJustRegistered, setHandlerJustRegistered] = createSignal(false);
  const [contributions] = createResource(loadPlatformContributions);
  const sharedAccount = isKnownSharedAuthRoutePresent();
  const [sharedProfile] = createResource(
    () => sharedAccount && props.session.subject,
    readSharedAccountProfile,
  );
  const profile = () => sharedAccount ? sharedProfile() : props.session;
  const accountPages = () =>
    platformContributionsForSlot(contributions(), "navigation.manage");

  const registerThisDevice = () => {
    try {
      registerInstallHandler();
      setHandlerRegistered(true);
      setHandlerJustRegistered(true);
    } catch {
      // The browser refused (no gesture / private mode); keep offering it.
    }
  };

  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    setSignOutUnavailable(false);
    let completed = false;
    try {
      completed = await signOutSession();
    } catch {
      completed = false;
    } finally {
      setSigningOut(false);
    }
    if (!completed) {
      setSignOutUnavailable(true);
      return;
    }
    nav("/sign-in");
  };

  const identityRows = () => [
    {
      label: t("account.profile.displayName"),
      value: profile()?.displayName ?? t("account.profile.notSet"),
    },
    {
      label: t("account.profile.email"),
      value: profile()?.email ?? t("account.profile.notSet"),
    },
    ...(props.session.provider
      ? [{ label: t("account.profile.provider"), value: props.session.provider }]
      : []),
  ];

  return (
    <div class="acct-stack">
      <section class="tg-settings-section" aria-label={t("account.profile.title")}>
        <dl class="tg-settings-group tg-settings-values">
          <For each={identityRows()}>
            {(item) => (
              <div class="tg-settings-row">
                <dt class="tg-settings-label">{item.label}</dt>
                <dd class="tg-settings-value">{item.value}</dd>
              </div>
            )}
          </For>
        </dl>
        <p class="tg-settings-note">{t("account.profile.nameHint")}</p>
      </section>

      <SignInMethodsCard />
      {props.children}

      <section class="tg-settings-section" aria-labelledby="account-preferences-heading">
        <h2 id="account-preferences-heading" class="tg-settings-heading">{t("account.preferences.title")}</h2>
        <div class="tg-settings-group">
          <label class="tg-settings-row">
            <span class="tg-settings-label">{t("account.language.title")}</span>
            <Select
              name="language"
              class="tg-settings-select"
              value={locale()}
              aria-label={t("account.language.title")}
              onChange={(event) => {
                const language = event.currentTarget.value;
                if (language === "ja" || language === "en") setLocale(language);
              }}
            >
              <option value="ja" lang="ja">日本語</option>
              <option value="en" lang="en">English</option>
            </Select>
          </label>
          <label class="tg-settings-row">
            <span class="tg-settings-label">{t("account.theme.title")}</span>
            <Select
              name="theme"
              class="tg-settings-select"
              value={themePreference()}
              aria-label={t("account.theme.title")}
              onChange={(event) => {
                const theme = event.currentTarget.value;
                if (theme === "system" || theme === "light" || theme === "dark")
                  setThemePreference(theme);
              }}
            >
              <For each={THEMES}>
                {(theme) => <option value={theme}>{t(THEME_LABEL_KEY[theme])}</option>}
              </For>
            </Select>
          </label>
        </div>
      </section>

      <section class="tg-settings-section" aria-label={t("account.installTarget.title")}>
        <div class="tg-settings-group">
          <div class="tg-settings-row tg-settings-row-wrap">
            <span class="tg-settings-label">{t("account.installTarget.title")}</span>
            <Show when={installHandlerAvailable && !handlerRegistered()} fallback={
              <span class="tg-settings-value">
                {installHandlerAvailable
                  ? t("account.installTarget.registered")
                  : t("account.installTarget.unsupported")}
              </span>
            }>
              <Button variant="ghost" size="sm" type="button" onClick={registerThisDevice}>
                {t("account.installTarget.register")}
              </Button>
            </Show>
          </div>
        </div>
        <Show when={handlerJustRegistered()}>
          <p class="tg-settings-note" role="status">{t("account.installTarget.done")}</p>
        </Show>
      </section>

      <Show when={accountPages().length > 0}>
        <section class="tg-settings-section" aria-labelledby="account-pages-heading">
          <h2 id="account-pages-heading" class="tg-settings-heading">{t("account.morePages.title")}</h2>
          <div class="tg-settings-group">
            <For each={accountPages()}>
              {(contribution) => (
                <a
                  href={contributionHref(contribution.href)}
                  class="tg-settings-row tg-settings-link"
                  rel="external"
                  title={platformContributionDescription(contribution, intlLocale())}
                >
                  <span class="tg-settings-label">{platformContributionLabel(contribution, intlLocale())}</span>
                  <ExternalLink size={15} aria-hidden="true" />
                </a>
              )}
            </For>
          </div>
        </section>
      </Show>

      <section class="tg-settings-section" aria-label={t("account.signOut.title")}>
        <div class="tg-settings-group">
          <Show when={confirmingSignOut()} fallback={
            <button
              ref={signOutAction}
              class="tg-settings-row tg-settings-link"
              type="button"
              onClick={() => {
                setSignOutUnavailable(false);
                setConfirmingSignOut(true);
                requestAnimationFrame(() => cancelSignOut?.focus());
              }}
            >
              <span class="tg-settings-label">{t("account.signOut.cta")}</span>
            </button>
          }>
            <div class="tg-settings-row tg-settings-row-wrap">
              <span class="tg-settings-label">{t("account.signOut.confirm")}</span>
              <div class="tg-settings-actions">
                <Button variant="secondary" size="sm" type="button" busy={signingOut()} onClick={signOut}>
                  {t("shell.signOut")}
                </Button>
                <Button
                  ref={cancelSignOut}
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={signingOut()}
                  onClick={() => {
                    setConfirmingSignOut(false);
                    requestAnimationFrame(() => signOutAction?.focus());
                  }}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
            <Show when={signOutUnavailable()}>
              <p role="alert">{t("account.signOut.unavailable")}</p>
            </Show>
          </Show>
        </div>
      </section>
    </div>
  );
}
