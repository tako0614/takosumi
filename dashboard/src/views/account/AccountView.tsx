/**
 * Account (`/account`) — sign-in info, the current browser session, and
 * language, merged from the former Hub / Profile / Sessions trio. The
 * account-plane has no subject-scoped session-enumeration API yet, so only the
 * current browser's session can be managed (stated honestly below).
 */
import "../../styles/wave-c.css";
import "../../styles/wave-b.css";
import { createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { LogOut, User } from "lucide-solid";
import Page from "./components/auth/Page.tsx";
import { clearSession, type SessionRecord } from "./lib/session.ts";
import { formatDateTime, locale, setLocale, t } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/index.ts";
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from "../../lib/theme.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  KVList,
  PageHeader,
} from "../../components/ui/index.ts";

const THEME_LABEL_KEY: Record<ThemePreference, MessageKey> = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
};

export default function AccountView() {
  return (
    <Page title={t("account.title")}>
      {(session) => <Inner session={session} />}
    </Page>
  );
}

function Inner(props: { readonly session: SessionRecord }) {
  const nav = useNavigate();
  const [busy, setBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);

  const signOutThisBrowser = () => {
    setBusy(true);
    clearSession();
    nav("/sign-in");
  };

  return (
    <>
      <PageHeader title={t("account.title")} subtitle={t("account.subtitle")} />

      <div class="wc-stack">
        <Card>
          <CardHeader
            title={
              <span style="display:inline-flex;align-items:center;gap:8px">
                <User size={18} /> {t("account.profile.title")}
              </span>
            }
          />
          <KVList
            items={[
              {
                label: t("account.profile.displayName"),
                value: props.session.displayName ?? "—",
              },
              {
                label: t("account.profile.email"),
                value: props.session.email ?? "—",
              },
            ]}
          />
          <CardSection>
            <Show
              when={confirming()}
              fallback={
                <Button
                  variant="danger"
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={busy()}
                  icon={<LogOut size={16} />}
                >
                  {t("account.session.signOut")}
                </Button>
              }
            >
              <div class="wc-form-actions">
                <span class="muted">{t("account.session.signOutConfirm")}</span>
                <Button
                  variant="danger"
                  size="sm"
                  type="button"
                  onClick={signOutThisBrowser}
                  disabled={busy()}
                  icon={<LogOut size={14} />}
                >
                  {t("shell.signOut")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy()}
                >
                  {t("common.cancel")}
                </Button>
              </div>
            </Show>
            <details class="wb-disclosure wc-advanced-settings">
              <summary>{t("account.session.details")}</summary>
              <p class="muted">{t("account.session.otherNote")}</p>
              <details class="wb-inline-details">
                <summary>{t("account.session.debug")}</summary>
                <KVList
                  items={[
                    {
                      label: t("account.profile.provider"),
                      value: props.session.provider ?? "—",
                    },
                    {
                      label: t("account.profile.subject"),
                      value: (
                        <code class="wc-code">{props.session.subject}</code>
                      ),
                    },
                    {
                      label: t("account.session.id"),
                      value: (
                        <code class="wc-code">{props.session.sessionId}</code>
                      ),
                    },
                    {
                      label: t("account.profile.expires"),
                      value: formatDateTime(
                        new Date(props.session.expiresAt).toISOString(),
                      ),
                    },
                    {
                      label: t("account.session.userAgent"),
                      value: (
                        <span class="muted">
                          {typeof navigator !== "undefined"
                            ? navigator.userAgent
                            : "—"}
                        </span>
                      ),
                    },
                  ]}
                />
              </details>
            </details>
          </CardSection>
        </Card>

        <Card>
          <CardHeader
            title={t("account.preferences.title")}
            subtitle={t("account.preferences.body")}
          />
          <CardSection>
            <div class="wc-stack-sm">
              <div>
                <p class="tg-card-title">{t("account.language.title")}</p>
                <div class="wc-form-actions tg-segmented">
                  <Button
                    variant={locale() === "ja" ? "primary" : "secondary"}
                    type="button"
                    onClick={() => setLocale("ja")}
                  >
                    日本語
                  </Button>
                  <Button
                    variant={locale() === "en" ? "primary" : "secondary"}
                    type="button"
                    onClick={() => setLocale("en")}
                  >
                    English
                  </Button>
                </div>
              </div>
              <div>
                <p class="tg-card-title">{t("account.theme.title")}</p>
                <div class="wc-form-actions tg-segmented">
                  {(["system", "light", "dark"] as const).map((theme) => (
                    <Button
                      variant={
                        themePreference() === theme ? "primary" : "secondary"
                      }
                      type="button"
                      onClick={() => setThemePreference(theme)}
                    >
                      {t(THEME_LABEL_KEY[theme])}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </CardSection>
        </Card>
      </div>
    </>
  );
}
