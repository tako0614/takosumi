import { createSignal, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Button, FormField, Input } from "../../components/ui/index.ts";
import { type MessageKey, t } from "../../i18n/index.ts";
import { safeOAuthReturnTo } from "../account/lib/auth.ts";
import { refreshSession } from "../account/lib/session.ts";
import { authenticateWithPassword, passwordErrorKey, type PasswordResult } from "../account/lib/password-auth.ts";
import "../../styles/password-auth.css";

export default function PasswordSignIn(props: {
  readonly returnTo?: string;
  readonly onPending: (pending: boolean) => void;
}) {
  const nav = useNavigate();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<MessageKey>();
  const [result, setResult] = createSignal<PasswordResult>();
  const controller = new AbortController();
  onCleanup(() => controller.abort());

  async function finish(value: PasswordResult) {
    const session = await refreshSession();
    if (controller.signal.aborted) return;
    if (!session || session.subject !== value.subject) throw new Error("Session could not be confirmed");
    const destination = safeOAuthReturnTo(props.returnTo);
    if (destination === "/oauth" || destination.startsWith("/oauth/")) location.assign(destination);
    else nav(destination, { replace: true });
  }

  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    if (busy()) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    props.onPending(true);
    setError(undefined);
    try {
      // A session refresh failure never repeats the credential mutation.
      const value = result() ?? await authenticateWithPassword(String(fields.get("username") ?? ""), String(fields.get("password") ?? ""), controller.signal);
      if (controller.signal.aborted) return;
      form.reset();
      setResult(value);
      await finish(value);
    } catch (error) {
      if (!controller.signal.aborted) setError(passwordErrorKey(error));
    } finally {
      if (!controller.signal.aborted) { setBusy(false); props.onPending(false); }
    }
  }

  return <form class="password-form password-sign-in" onSubmit={(event) => void submit(event)} aria-label={t("password.login")}>
    <h2>{t("password.login")}</h2>
    <Show when={!result()}>
      <FormField label={t("password.username")} required>
        <Input aria-label={t("password.username")} name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck={false} required disabled={busy()} />
      </FormField>
      <FormField label={t("password.password")} required>
        <Input aria-label={t("password.password")} name="password" type="password" autocomplete="current-password" required disabled={busy()} />
      </FormField>
    </Show>
    <Button type="submit" variant="primary" busy={busy()}>{t(result() ? "password.continue" : "password.login")}</Button>
    <Show when={error()}><p class="sign-in-error" role="alert">{t(error()!)}</p></Show>
  </form>;
}
