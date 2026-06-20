/**
 * Account (`/account`) — sign-in info, the current browser session, and
 * language, merged from the former Hub / Profile / Sessions trio. The
 * account-plane has no subject-scoped session-enumeration API yet, so only the
 * current browser's session can be managed (stated honestly below).
 */
import { createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { LogOut, Monitor, User } from "lucide-solid";
import AppShell from "./components/shell/AppShell.tsx";
import Page from "./components/auth/Page.tsx";
import { clearSession, type SessionRecord } from "./lib/session.ts";
import { formatDateTime, locale, setLocale, t } from "../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  KVList,
  PageHeader,
} from "../../components/ui/index.ts";

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
    <AppShell>
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
                label: t("account.profile.subject"),
                value: <code class="wc-code">{props.session.subject}</code>,
              },
              {
                label: t("account.profile.displayName"),
                value: props.session.displayName ?? "—",
              },
              {
                label: t("account.profile.email"),
                value: props.session.email ?? "—",
              },
              {
                label: t("account.profile.provider"),
                value: props.session.provider ?? "—",
              },
              {
                label: t("account.profile.expires"),
                value: formatDateTime(
                  new Date(props.session.expiresAt).toISOString(),
                ),
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader
            title={t("account.language.title")}
            subtitle={t("account.language.body")}
          />
          <div class="wc-form-actions">
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
        </Card>

        <Card>
          <CardHeader
            title={
              <span style="display:inline-flex;align-items:center;gap:8px">
                <Monitor size={18} /> {t("account.session.title")}
              </span>
            }
          />
          <KVList
            items={[
              {
                label: t("account.session.id"),
                value: <code class="wc-code">{props.session.sessionId}</code>,
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
            <p class="muted">{t("account.session.otherNote")}</p>
          </CardSection>
        </Card>
      </div>
    </AppShell>
  );
}
