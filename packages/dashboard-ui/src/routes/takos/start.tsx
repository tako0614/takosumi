import { Title } from "@solidjs/meta";
import { useSearchParams } from "@solidjs/router";
import { Rocket } from "lucide-solid";
import { createSignal, Show } from "solid-js";
import AuthGuard from "~/components/auth/AuthGuard";
import AppShell from "~/components/shell/AppShell";
import {
  buildUseTakosStartUrl,
  DEFAULT_USE_TAKOS_TERMS_VERSION,
  tryDefaultTakosUrlForHost,
} from "~/lib/use-takos-start";

export default function UseTakos() {
  return (
    <>
      <Title>Start Takos - Takosumi</Title>
      <AuthGuard>{(session) => <Inner subject={session.subject} />}</AuthGuard>
    </>
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
  const origin = typeof location === "undefined"
    ? "https://accounts.takosumi.com"
    : location.origin;
  const storage = typeof localStorage === "undefined"
    ? undefined
    : localStorage;

  // Use the non-throwing variant: on a non-local host with no configured
  // Takos URL this returns undefined, so we seed the (required,
  // user-editable) input with "" and let validation/the user fill it in
  // rather than crashing the render during component setup.
  const [takosUrl, setTakosUrl] = createSignal(
    params.takos_url ?? params.takosUrl ?? tryDefaultTakosUrlForHost(host) ??
      "",
  );
  const [accountId, setAccountId] = createSignal(
    params.account_id ?? params.accountId ??
      storage?.getItem("tg_apps_account_id") ?? "",
  );
  const [spaceId, setSpaceId] = createSignal(
    params.space_id ?? params.spaceId ?? storage?.getItem("tg_apps_space_id") ??
      "",
  );
  const [termsVersion, setTermsVersion] = createSignal(
    params.terms_version ?? params.termsVersion ??
      DEFAULT_USE_TAKOS_TERMS_VERSION,
  );
  const [termsAccepted, setTermsAccepted] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const submit = (event: Event) => {
    event.preventDefault();
    setErr(null);
    if (!accountId() || !spaceId()) {
      setErr("Account ID と Space ID を入力してください。");
      return;
    }
    if (!termsAccepted()) {
      setErr("利用規約への同意が必要です。");
      return;
    }
    storage?.setItem("tg_apps_account_id", accountId());
    storage?.setItem("tg_apps_space_id", spaceId());
    location.assign(buildUseTakosStartUrl({
      origin,
      takosUrl: takosUrl(),
      subject: props.subject,
      accountId: accountId(),
      spaceId: spaceId(),
      installationId: params.installation_id ?? params.installationId,
      appId: params.app_id ?? params.appId,
      termsVersion: termsVersion(),
      returnTo: params.return_to ?? params.returnTo,
    }));
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>Use Takos</h1>
        <p class="page-sub">
          Account と Space を確認して、Takos を開始します。
        </p>
      </div>

      <form onSubmit={submit}>
        <section class="detail-section">
          <h2>Takos launch</h2>
          <div class="install-grid">
            <label>
              Takos URL
              <input
                type="url"
                value={takosUrl()}
                onInput={(e) => setTakosUrl(e.currentTarget.value)}
                required
              />
            </label>
            <label>
              Terms version
              <input
                type="text"
                value={termsVersion()}
                onInput={(e) => setTermsVersion(e.currentTarget.value)}
                required
              />
            </label>
          </div>
        </section>

        <section class="detail-section">
          <h2>Account and Space</h2>
          <div class="install-grid">
            <label>
              Account ID
              <input
                type="text"
                value={accountId()}
                onInput={(e) => setAccountId(e.currentTarget.value)}
                placeholder="acct_xxxxx"
                required
              />
            </label>
            <label>
              Space ID
              <input
                type="text"
                value={spaceId()}
                onInput={(e) => setSpaceId(e.currentTarget.value)}
                placeholder="space_xxxxx"
                required
              />
            </label>
          </div>
        </section>

        <section class="detail-section">
          <h2>Terms</h2>
          <label class="check">
            <input
              type="checkbox"
              checked={termsAccepted()}
              onChange={(e) => setTermsAccepted(e.currentTarget.checked)}
            />
            <span>
              Takosumi の利用規約に同意します。
            </span>
          </label>
          <Show when={err()}>
            {(m) => <p class="sign-in-error" role="alert">{m()}</p>}
          </Show>
          <button
            class="btn btn-primary"
            type="submit"
            disabled={!accountId() || !spaceId() || !takosUrl() ||
              !termsAccepted()}
          >
            <Rocket size={16} /> Launch Takos
          </button>
        </section>
      </form>
    </AppShell>
  );
}
