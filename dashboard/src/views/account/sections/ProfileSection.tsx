/**
 * アカウント > 自分: who you are signed in as, how the dashboard looks and
 * reads, where store install links open, and signing out of this browser.
 * Sign-out is the last card and a plain action with a one-step confirmation.
 * Operator-installed account pages (`navigation.manage` contributions) are
 * listed here when the service provides any.
 */
import { createResource, createSignal, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { ExternalLink, LogOut } from "lucide-solid";
import { clearSession, type SessionRecord } from "../lib/session.ts";
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
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  KVList,
} from "../../../components/ui/index.ts";

const THEME_LABEL_KEY: Record<ThemePreference, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

function contributionHref(href: string): string {
  const workspaceId = currentWorkspaceId();
  if (!workspaceId) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}workspaceId=${encodeURIComponent(workspaceId)}`;
}

export default function ProfileSection(props: {
  readonly session: SessionRecord;
}) {
  const nav = useNavigate();
  const [signingOut, setSigningOut] = createSignal(false);
  const [confirmingSignOut, setConfirmingSignOut] = createSignal(false);
  const installHandlerAvailable = installHandlerSupported();
  const [handlerRegistered, setHandlerRegistered] = createSignal(
    installHandlerRegistered(),
  );
  const [handlerJustRegistered, setHandlerJustRegistered] = createSignal(false);
  const [contributions] = createResource(loadPlatformContributions);
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

  const signOut = () => {
    setSigningOut(true);
    clearSession();
    // Sign-out must never hand the user straight back to a single-provider
    // auto-start (see UserMenu.signOut).
    nav("/sign-in");
  };

  return (
    <div class="acct-stack">
      <Card>
        <CardHeader title={t("account.profile.title")} />
        <KVList
          items={[
            {
              label: t("account.profile.displayName"),
              value: props.session.displayName ?? (
                <span class="muted">{t("account.profile.notSet")}</span>
              ),
            },
            {
              label: t("account.profile.email"),
              value: props.session.email ?? (
                <span class="muted">{t("account.profile.notSet")}</span>
              ),
            },
            ...(props.session.provider
              ? [
                  {
                    label: t("account.profile.provider"),
                    value: props.session.provider,
                  },
                ]
              : []),
          ]}
        />
        <CardSection>
          <p class="muted">{t("account.profile.nameHint")}</p>
        </CardSection>
      </Card>

      <Card>
        <CardHeader
          title={t("account.preferences.title")}
          subtitle={t("account.preferences.body")}
        />
        <CardSection>
          <div class="acct-pref">
            <p class="acct-pref-label">{t("account.language.title")}</p>
            <div class="wc-form-actions tg-segmented">
              <Button
                variant={locale() === "ja" ? "primary" : "secondary"}
                aria-pressed={locale() === "ja"}
                type="button"
                onClick={() => setLocale("ja")}
              >
                日本語
              </Button>
              <Button
                variant={locale() === "en" ? "primary" : "secondary"}
                aria-pressed={locale() === "en"}
                type="button"
                onClick={() => setLocale("en")}
              >
                English
              </Button>
            </div>
          </div>
          <div class="acct-pref">
            <p class="acct-pref-label">{t("account.theme.title")}</p>
            <div class="wc-form-actions tg-segmented">
              {(["system", "light", "dark"] as const).map((theme) => (
                <Button
                  variant={themePreference() === theme ? "primary" : "secondary"}
                  aria-pressed={themePreference() === theme}
                  type="button"
                  onClick={() => setThemePreference(theme)}
                >
                  {t(THEME_LABEL_KEY[theme])}
                </Button>
              ))}
            </div>
          </div>
        </CardSection>
      </Card>

      <Card>
        <CardHeader
          title={t("account.installTarget.title")}
          subtitle={t("account.installTarget.body")}
        />
        <CardSection>
          <Show
            when={installHandlerAvailable}
            fallback={
              <p class="muted">{t("account.installTarget.unsupported")}</p>
            }
          >
            <div class="wc-form-actions">
              <Button
                variant="secondary"
                aria-pressed={handlerRegistered()}
                type="button"
                onClick={registerThisDevice}
              >
                {handlerRegistered()
                  ? t("account.installTarget.registered")
                  : t("account.installTarget.register")}
              </Button>
            </div>
            <Show when={handlerJustRegistered()}>
              <p class="muted">{t("account.installTarget.done")}</p>
            </Show>
          </Show>
        </CardSection>
      </Card>

      <Show when={accountPages().length > 0}>
        <Card>
          <CardHeader title={t("account.morePages.title")} />
          <ul class="acct-link-list">
            <For each={accountPages()}>
              {(contribution) => (
                <li>
                  {/* Extension documents live outside the SPA route table. */}
                  <a href={contributionHref(contribution.href)} rel="external">
                    <span>
                      {platformContributionLabel(contribution, intlLocale())}
                    </span>
                    <Show
                      when={platformContributionDescription(
                        contribution,
                        intlLocale(),
                      )}
                    >
                      {(description) => (
                        <small class="muted">{description()}</small>
                      )}
                    </Show>
                    <ExternalLink size={14} aria-hidden="true" />
                  </a>
                </li>
              )}
            </For>
          </ul>
        </Card>
      </Show>

      <Card>
        <CardHeader
          title={t("account.signOut.title")}
          subtitle={t("account.signOut.body")}
        />
        <CardSection>
          <Show
            when={confirmingSignOut()}
            fallback={
              <Button
                variant="secondary"
                type="button"
                icon={<LogOut size={16} />}
                onClick={() => setConfirmingSignOut(true)}
              >
                {t("account.signOut.cta")}
              </Button>
            }
          >
            <div class="wc-form-actions">
              <span>{t("account.signOut.confirm")}</span>
              <Button
                variant="primary"
                size="sm"
                type="button"
                busy={signingOut()}
                onClick={signOut}
              >
                {t("shell.signOut")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                disabled={signingOut()}
                onClick={() => setConfirmingSignOut(false)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </Show>
        </CardSection>
      </Card>
    </div>
  );
}
