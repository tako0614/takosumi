import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { Button, Card, CardHeader, CardSection, FormField, Input, KVList } from "../../../components/ui/index.ts";
import { type MessageKey, t } from "../../../i18n/index.ts";
import { passwordErrorKey, readSignInMethods, setAccountPassword, validNewPassword } from "../lib/password-auth.ts";
import { refreshSession } from "../lib/session.ts";
import "../../../styles/password-auth.css";

export default function SignInMethodsCard() {
  const [methods, { refetch }] = createResource(readSignInMethods);
  const data = () => methods.error ? undefined : methods();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<MessageKey>();
  const [saved, setSaved] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const signInHref = "/sign-in?return=%2Faccount";

  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    if (busy()) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const username = String(fields.get("username") ?? "").trim();
    const password = String(fields.get("password") ?? "");
    const currentPassword = String(fields.get("currentPassword") ?? "");
    setError(undefined);
    setSaved(false);
    if (!validNewPassword(password)) { setError("password.error.length"); return; }
    if (password !== fields.get("confirmPassword")) { setError("password.error.confirm"); return; }
    setBusy(true);
    try {
      const result = await setAccountPassword({ password, ...(username ? { username } : {}), ...(currentPassword ? { currentPassword } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      form.reset();
      setSaved(true);
      const session = await refreshSession();
      if (controller.signal.aborted) return;
      if (!session || session.subject !== result.subject) throw new Error("Session could not be confirmed");
      await refetch();
    } catch (error) {
      if (!controller.signal.aborted) setError(passwordErrorKey(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <Show when={methods.loading || methods.error || data()}>
    <Card>
      <CardHeader title={t("password.methods.title")} subtitle={t("password.methods.body")} />
      <CardSection>
        <Show when={methods.error}>
          <p role="alert">{t(passwordErrorKey(methods.error))}</p>
          <Button type="button" onClick={() => void refetch()}>{t("common.retry")}</Button>
        </Show>
        <Show when={methods.loading && !data()}><p role="status">{t("common.loading")}</p></Show>
        <Show when={data()}>
          {(method) => <>
            <Show when={method().username}>
              {(username) => <KVList items={[{ label: t("password.username"), value: username() }]} />}
            </Show>
            <Show when={method().passwordEnabled} fallback={<p class="muted">{t("password.methods.unavailable")}</p>}>
              <Show when={method().canSetPassword} fallback={<p class="muted">
                {t(method().eligible ? "password.methods.freshSession" : "password.methods.linkRequired")} <Show when={method().eligible}><a href={signInHref}>{t("password.methods.reauthenticate")}</a></Show>
              </p>}>
                <form class="password-form" onSubmit={(event) => void submit(event)} aria-label={t(method().hasPassword ? "password.methods.change" : "password.methods.set")}>
                  <Show when={!method().hasPassword}>
                    <FormField label={t("password.username")} required>
                      <Input aria-label={t("password.username")} name="username" autocomplete="username" autocapitalize="none"
                        spellcheck={false} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,31}" title={t("password.usernameHint")} required disabled={busy()} />
                    </FormField>
                  </Show>
                  <Show when={method().hasPassword}>
                    <FormField label={t("password.currentPassword")}>
                      <Input aria-label={t("password.currentPassword")} name="currentPassword" type="password" autocomplete="current-password" disabled={busy()} />
                    </FormField>
                    <p class="muted">{t("password.methods.proofHint")} <a href={signInHref}>{t("password.methods.reauthenticate")}</a></p>
                  </Show>
                  <FormField label={t("password.newPassword")} hint={t("password.passwordHint")} required>
                    <Input aria-label={t("password.newPassword")} name="password" type="password" autocomplete="new-password" required disabled={busy()} />
                  </FormField>
                  <FormField label={t("password.confirmPassword")} required>
                    <Input aria-label={t("password.confirmPassword")} name="confirmPassword" type="password" autocomplete="new-password" required disabled={busy()} />
                  </FormField>
                  <Button type="submit" variant="primary" busy={busy()}>{t(method().hasPassword ? "password.methods.change" : "password.methods.set")}</Button>
                </form>
              </Show>
            </Show>
          </>}
        </Show>
        <Show when={saved()}><p role="status">{t("password.methods.saved")}</p></Show>
        <Show when={error()}><p class="sign-in-error" role="alert">{t(error()!)}</p></Show>
      </CardSection>
    </Card>
  </Show>;
}
