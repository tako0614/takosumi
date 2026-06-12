/**
 * Space settings — 一般: display name + (folded) policy JSON. Successor of the
 * Space part of the old AccountSettingsView; the Space is the one selected in
 * the global switcher.
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Show,
} from "solid-js";
import {
  listSpaces,
  type PolicyConfig,
  updateSpace,
} from "../../../lib/control-api.ts";
import { formatDateTime, t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  FormField,
  Input,
  KVList,
  Textarea,
  Toast,
} from "../../../components/ui/index.ts";

export default function GeneralTab(props: { readonly spaceId: string }) {
  const [spaces, { refetch }] = createResource(listSpaces);
  const space = createMemo(() =>
    (spaces() ?? []).find((item) => item.id === props.spaceId),
  );
  const [displayNameDraft, setDisplayNameDraft] = createSignal("");
  const [policyDraft, setPolicyDraft] = createSignal("{}");
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  createEffect(() => {
    const current = space();
    if (!current) return;
    setDisplayNameDraft(current.displayName);
    setPolicyDraft(JSON.stringify(current.policy ?? {}, null, 2));
    setSaveError(null);
    setSaveMessage(null);
  });

  const save = async (event: Event) => {
    event.preventDefault();
    const current = space();
    if (!current) return;
    const displayName = displayNameDraft().trim();
    if (!displayName) {
      setSaveError(t("spaceSettings.general.nameRequired"));
      return;
    }
    let policy: PolicyConfig;
    try {
      const parsed = JSON.parse(policyDraft());
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        setSaveError(t("spaceSettings.general.policyObject"));
        return;
      }
      policy = parsed as PolicyConfig;
    } catch {
      setSaveError(t("spaceSettings.general.policyInvalid"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateSpace(current.id, { displayName, policy });
      await refetch();
      setSaveMessage(t("spaceSettings.general.saved"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("spaceSettings.tab.general")} />
      <Show when={space()} fallback={<p class="muted">{t("common.loading")}</p>}>
        {(current) => (
          <>
            <KVList
              items={[
                {
                  label: t("spaceSettings.general.handle"),
                  value: <code>@{current().handle}</code>,
                },
                {
                  label: t("spaceSettings.general.type"),
                  value: <code>{current().type}</code>,
                },
                {
                  label: t("spaceSettings.general.owner"),
                  value: <code>{current().ownerUserId}</code>,
                },
                {
                  label: t("spaceSettings.general.updated"),
                  value: formatDateTime(current().updatedAt),
                },
              ]}
            />
            <CardSection>
              <form class="wc-form" onSubmit={save}>
                <FormField label={t("spaceSettings.general.displayName")}>
                  <Input
                    value={displayNameDraft()}
                    onInput={(e) => setDisplayNameDraft(e.currentTarget.value)}
                  />
                </FormField>
                <details class="wb-disclosure">
                  <summary>{t("spaceSettings.general.policyAdvanced")}</summary>
                  <Textarea
                    class="wc-policy-editor"
                    spellcheck={false}
                    rows={10}
                    value={policyDraft()}
                    onInput={(e) => setPolicyDraft(e.currentTarget.value)}
                  />
                </details>
                <div class="wc-form-actions">
                  <Button variant="primary" type="submit" busy={saving()}>
                    {saving() ? t("common.saving") : t("common.save")}
                  </Button>
                </div>
                <Show when={saveError()}>
                  {(message) => <Toast tone="error">{message()}</Toast>}
                </Show>
                <Show when={saveMessage()}>
                  {(message) => <Toast tone="success">{message()}</Toast>}
                </Show>
              </form>
            </CardSection>
          </>
        )}
      </Show>
    </Card>
  );
}
