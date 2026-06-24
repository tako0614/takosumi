/**
 * Workspace settings — 一般: display name + (folded) policy JSON. Successor of the
 * Workspace part of the old AccountSettingsView; the Workspace is the one selected in
 * the global switcher.
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Show,
} from "solid-js";
import { listSpaces, updateSpace } from "../../../lib/control-api.ts";
import { setCurrentSpaceId } from "../../../lib/space-state.ts";
import { formatDateTime, t } from "../../../i18n/index.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  FormField,
  Input,
  KVList,
  Toast,
} from "../../../components/ui/index.ts";

export default function GeneralTab(props: { readonly spaceId: string }) {
  const [spaces, { refetch }] = createResource(listSpaces);
  const space = createMemo(() =>
    (spaces() ?? []).find((item) => item.id === props.spaceId),
  );
  const [displayNameDraft, setDisplayNameDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [archiving, setArchiving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  createEffect(() => {
    const current = space();
    if (!current) return;
    setDisplayNameDraft(current.displayName);
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
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateSpace(current.id, { displayName });
      await refetch();
      setSaveMessage(t("spaceSettings.general.saved"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    const current = space();
    if (!current) return;
    if ((spaces() ?? []).length <= 1) {
      setSaveError(t("spaceSettings.general.archiveLastError"));
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(t("spaceSettings.general.archiveConfirm"))
    ) {
      return;
    }
    setArchiving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateSpace(current.id, { archived: true });
      setCurrentSpaceId("");
      await refetch();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("takosumi:spaces-changed"));
      }
      setSaveMessage(t("spaceSettings.general.archived"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("spaceSettings.tab.general")} />
      <Show
        when={space()}
        fallback={<p class="muted">{t("common.loading")}</p>}
      >
        {(current) => (
          <>
            <KVList
              items={[
                {
                  label: t("spaceSettings.general.handle"),
                  value: <code>@{current().handle}</code>,
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
                <details class="wb-disclosure wc-advanced-settings">
                  <summary>
                    {t("spaceSettings.general.advancedDetails")}
                  </summary>
                  <KVList
                    items={[
                      {
                        label: t("spaceSettings.general.type"),
                        value: <code>{current().type}</code>,
                      },
                      {
                        label: t("spaceSettings.general.owner"),
                        value: <code>{current().ownerUserId}</code>,
                      },
                    ]}
                  />
                  <div class="wc-form-actions">
                    <Button
                      variant="danger"
                      type="button"
                      busy={archiving()}
                      disabled={archiving() || (spaces() ?? []).length <= 1}
                      onClick={archive}
                    >
                      {archiving()
                        ? t("common.saving")
                        : t("spaceSettings.general.archive")}
                    </Button>
                  </div>
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
