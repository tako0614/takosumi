/**
 * Takos product launch (`/takos/start`) — confirms the launch target and terms,
 * then redirects to the `/start` launch URL. Reached from the takos product
 * itself (query-parameterized); also usable by hand.
 *
 * Cleaned up from the legacy screen: the terms VERSION is an internal constant
 * (or query param), never a user-editable field; account / space ids prefill
 * from the query / last-used values and only need typing when genuinely absent.
 */
import "../../styles/wave-c.css";
import { createSignal, onMount, Show } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { Play } from "lucide-solid";
import AppShell from "./components/shell/AppShell.tsx";
import Page from "./components/auth/Page.tsx";
import type { SessionRecord } from "./lib/session.ts";
import { setDocumentTitle, t } from "../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  Checkbox,
  FormField,
  Input,
} from "../../components/ui/index.ts";

const DEFAULT_USE_TAKOS_TERMS_VERSION = "terms-2026-05-13";

interface UseTakosStartUrlInput {
  readonly origin: string;
  readonly takosUrl: string;
  readonly subject: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly appId?: string;
  readonly termsVersion?: string;
  readonly returnTo?: string;
}

function tryDefaultTakosUrlForHost(hostname: string): string | undefined {
  if (isLocalHost(hostname)) return "https://takos.test";
  const configured = (
    import.meta.env.VITE_TAKOSUMI_DASHBOARD_TAKOS_URL as string | undefined
  )?.trim();
  if (configured) return configured;
  return undefined;
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname.endsWith(".test") ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function safeReturnTo(value: string | undefined, spaceId: string): string {
  if (value?.startsWith("/") && !value.startsWith("//")) return value;
  return `/spaces/${spaceId}/threads`;
}

function buildUseTakosStartUrl(input: UseTakosStartUrlInput): string {
  const url = new URL("/start", input.origin);
  url.searchParams.set("takos_url", input.takosUrl);
  url.searchParams.set("subject", input.subject);
  url.searchParams.set("account_id", input.accountId);
  url.searchParams.set("space_id", input.spaceId);
  if (input.installationId) {
    url.searchParams.set("installation_id", input.installationId);
  }
  if (input.appId) {
    url.searchParams.set("app_id", input.appId);
  }
  url.searchParams.set(
    "terms_version",
    input.termsVersion ?? DEFAULT_USE_TAKOS_TERMS_VERSION,
  );
  url.searchParams.set("terms_accepted", "true");
  url.searchParams.set(
    "return_to",
    safeReturnTo(input.returnTo, input.spaceId),
  );
  return url.toString();
}

export default function TakosStartView() {
  onMount(() => setDocumentTitle(t("start.title")));
  return (
    <Page>
      {(session: SessionRecord) => <Inner subject={session.subject} />}
    </Page>
  );
}

function Inner(props: { subject: string }) {
  const [params] = useSearchParams<{
    takos_url?: string;
    takosUrl?: string;
    account_id?: string;
    accountId?: string;
    space_id?: string;
    spaceId?: string;
    installation_id?: string;
    installationId?: string;
    app_id?: string;
    appId?: string;
    terms_version?: string;
    termsVersion?: string;
    return_to?: string;
    returnTo?: string;
  }>();
  const host = typeof location === "undefined" ? "" : location.hostname;
  const origin =
    typeof location === "undefined"
      ? "https://app.takosumi.com"
      : location.origin;
  const storage =
    typeof localStorage === "undefined" ? undefined : localStorage;

  const [takosUrl, setTakosUrl] = createSignal(
    params.takos_url ??
      params.takosUrl ??
      tryDefaultTakosUrlForHost(host) ??
      "",
  );
  const [accountId, setAccountId] = createSignal(
    params.account_id ??
      params.accountId ??
      storage?.getItem("tg_apps_account_id") ??
      "",
  );
  const [spaceId, setSpaceId] = createSignal(
    params.space_id ??
      params.spaceId ??
      storage?.getItem("tg_apps_space_id") ??
      "",
  );
  // Internal metadata — comes from the query (set by the takos product) or the
  // current default. Never a user-editable field.
  const termsVersion =
    params.terms_version ?? params.termsVersion ?? DEFAULT_USE_TAKOS_TERMS_VERSION;
  const [termsAccepted, setTermsAccepted] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const submit = (event: Event) => {
    event.preventDefault();
    setErr(null);
    if (!accountId() || !spaceId()) {
      setErr(t("start.error.idsRequired"));
      return;
    }
    if (!termsAccepted()) {
      setErr(t("start.error.termsRequired"));
      return;
    }
    storage?.setItem("tg_apps_account_id", accountId());
    storage?.setItem("tg_apps_space_id", spaceId());
    location.assign(
      buildUseTakosStartUrl({
        origin,
        takosUrl: takosUrl(),
        subject: props.subject,
        accountId: accountId(),
        spaceId: spaceId(),
        installationId: params.installation_id ?? params.installationId,
        appId: params.app_id ?? params.appId,
        termsVersion,
        returnTo: params.return_to ?? params.returnTo,
      }),
    );
  };

  return (
    <AppShell>
      <Card>
        <CardHeader title={t("start.title")} subtitle={t("start.subtitle")} />
        <CardSection>
          <form class="wc-form" onSubmit={submit}>
            <FormField label={t("start.takosUrl")} required>
              <Input
                type="url"
                value={takosUrl()}
                onInput={(e) => setTakosUrl(e.currentTarget.value)}
                required
              />
            </FormField>
            <div class="wb-form-row">
              <FormField label={t("start.account")} required>
                <Input
                  type="text"
                  value={accountId()}
                  onInput={(e) => setAccountId(e.currentTarget.value)}
                  placeholder="acct_xxxxx"
                  required
                />
              </FormField>
              <FormField label={t("start.space")} required>
                <Input
                  type="text"
                  value={spaceId()}
                  onInput={(e) => setSpaceId(e.currentTarget.value)}
                  placeholder="space_xxxxx"
                  required
                />
              </FormField>
            </div>
            <Checkbox
              checked={termsAccepted()}
              onChange={(e) => setTermsAccepted(e.currentTarget.checked)}
              label={t("start.terms")}
            />
            <Show when={err()}>
              {(m) => <p class="wb-error" role="alert">{m()}</p>}
            </Show>
            <div class="wc-form-actions">
              <Button
                variant="primary"
                type="submit"
                disabled={
                  !accountId() || !spaceId() || !takosUrl() || !termsAccepted()
                }
                icon={<Play size={16} />}
              >
                {t("start.launch")}
              </Button>
            </div>
          </form>
        </CardSection>
      </Card>
    </AppShell>
  );
}
