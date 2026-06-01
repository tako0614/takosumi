import { Title } from "@solidjs/meta";
import { KeyRound, ShieldAlert } from "lucide-solid";
import { createSignal, Show } from "solid-js";
import AppShell from "~/components/shell/AppShell";
import AuthGuard from "~/components/auth/AuthGuard";
import {
  completePasskeyRegistration,
  requestPasskeyRegisterOptions,
} from "~/lib/api/passkey";
import {
  b64urlToBuf,
  bufToB64url,
  coseToJwk,
  extractCosePublicKey,
} from "~/lib/webauthn/cose";

export default function Security() {
  return (
    <>
      <Title>セキュリティ — Takosumi</Title>
      <AuthGuard>{(session) => <Inner subject={session.subject} />}</AuthGuard>
    </>
  );
}

function Inner(props: { subject: string }) {
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const addPasskey = async () => {
    setBusy(true);
    setErr(null);
    setStatus(null);
    try {
      if (
        !("credentials" in navigator) ||
        typeof globalThis.PublicKeyCredential === "undefined"
      ) {
        throw new Error("このブラウザは WebAuthn に対応していません。");
      }
      const opts = await requestPasskeyRegisterOptions(props.subject);
      const pubKeyCredParams = opts.pubKeyCredParams?.map((param) => ({
        ...param,
      })) ?? [];
      if (pubKeyCredParams.length === 0) {
        throw new Error("passkey 登録オプションが不完全です。");
      }
      const cred = (await navigator.credentials.create({
        publicKey: {
          ...opts,
          pubKeyCredParams,
          challenge: b64urlToBuf(opts.challenge),
          user: { ...opts.user, id: b64urlToBuf(opts.user.id) },
          excludeCredentials: (opts.excludeCredentials ?? []).map((c) => ({
            ...c,
            id: b64urlToBuf(c.id),
          })),
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new Error("credential creation cancelled");

      const response = cred.response as AuthenticatorAttestationResponse;
      const jwk = coseToJwk(extractCosePublicKey(response.attestationObject));

      await completePasskeyRegistration({
        subject: props.subject,
        credentialId: bufToB64url(cred.rawId),
        publicKeyJwk: jwk,
        // Echo back the server-minted challenge plus the raw ceremony
        // material so the server can verify the registration (challenge /
        // origin / attestation format) instead of trusting the JWK alone.
        challenge: opts.challenge,
        clientDataJSON: bufToB64url(response.clientDataJSON),
        attestationObject: bufToB64url(response.attestationObject),
        transports: response.getTransports?.() ?? [],
      });
      setStatus("Passkey を登録しました。");
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div class="page-header">
        <h1>セキュリティ</h1>
        <p class="page-sub">
          passkey の登録 / 接続している upstream OAuth プロバイダの確認。
        </p>
      </div>

      <section class="detail-section">
        <h2>
          <KeyRound size={18} /> Passkey
        </h2>
        <p class="muted">
          現在のアカウントに新しい passkey を登録します。 Touch ID / Face ID /
          Windows Hello / セキュリティキーが使えます。 ローカルブラウザ環境
          (self-signed cert / non-HTTPS) では失敗する場合があります。
        </p>
        <button
          class="btn btn-primary"
          type="button"
          onClick={addPasskey}
          disabled={busy()}
        >
          <KeyRound size={16} /> {busy() ? "登録中..." : "Passkey を追加"}
        </button>
        <Show when={status()}>
          {(m) => (
            <p class="muted" style="margin-top: 8px;">
              {m()}
            </p>
          )}
        </Show>
        <Show when={err()}>{(m) => <p class="sign-in-error">{m()}</p>}</Show>
        <p class="muted" style="margin-top: 16px;">
          登録済み passkey の一覧表示と削除 (coming soon): 現在この
          account-plane には passkey の列挙 / 失効 API がないため、UI
          からの監査・削除はまだできません。 紛失した端末の passkey
          はサインインで使われた upstream プロバイダ側から無効化してください。
        </p>
      </section>

      <section class="detail-section">
        <h2>
          <ShieldAlert size={18} /> Upstream OAuth
        </h2>
        <p class="muted">
          接続済みの Google / GitHub アカウントの一覧表示 (coming soon):
          現在この account-plane には接続済み upstream プロバイダを返す API
          がないため、ここにはまだ表示されません。
        </p>
      </section>
    </AppShell>
  );
}

// COSE / CBOR helpers (extractCosePublicKey, coseToJwk, b64urlToBuf,
// bufToB64url) extracted to ~/lib/webauthn/cose.ts so they can be
// unit-tested without booting the SPA. See cose.test.ts.
