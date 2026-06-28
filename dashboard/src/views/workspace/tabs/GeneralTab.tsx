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
import { listWorkspaces, updateWorkspace } from "../../../lib/control-api.ts";
import { setCurrentWorkspaceId } from "../../../lib/workspace-state.ts";
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

export default function GeneralTab(props: { readonly workspaceId: string }) {
  const [workspaces, { refetch }] = createResource(listWorkspaces);
  const workspace = createMemo(() =>
    (workspaces() ?? []).find((item) => item.id === props.workspaceId),
  );
  const [displayNameDraft, setDisplayNameDraft] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [archiving, setArchiving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saveMessage, setSaveMessage] = createSignal<string | null>(null);

  createEffect(() => {
    const current = workspace();
    if (!current) return;
    setDisplayNameDraft(current.displayName);
    setSaveError(null);
    setSaveMessage(null);
  });

  const save = async (event: Event) => {
    event.preventDefault();
    const current = workspace();
    if (!current) return;
    const displayName = displayNameDraft().trim();
    if (!displayName) {
      setSaveError(t("workspaceSettings.general.nameRequired"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateWorkspace(current.id, { displayName });
      await refetch();
      setSaveMessage(t("workspaceSettings.general.saved"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    const current = workspace();
    if (!current) return;
    if ((workspaces() ?? []).length <= 1) {
      setSaveError(t("workspaceSettings.general.archiveLastError"));
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(t("workspaceSettings.general.archiveConfirm"))
    ) {
      return;
    }
    setArchiving(true);
    setSaveError(null);
    setSaveMessage(null);
    try {
      await updateWorkspace(current.id, { archived: true });
      setCurrentWorkspaceId("");
      await refetch();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("takosumi:workspaces-changed"));
      }
      setSaveMessage(t("workspaceSettings.general.archived"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  };

  return (
    <Card>
      <CardHeader title={t("workspaceSettings.tab.general")} />
      <Show
        when={workspace()}
        fallback={<p class="muted">{t("common.loading")}</p>}
      >
        {(current) => (
          <>
            <KVList
              items={[
                {
                  label: t("workspaceSettings.general.handle"),
                  value: <code>@{current().handle}</code>,
                },
                {
                  label: t("workspaceSettings.general.updated"),
                  value: formatDateTime(current().updatedAt),
                },
              ]}
            />
            <CardSection>
              <form class="wc-form" onSubmit={save}>
                <FormField label={t("workspaceSettings.general.displayName")}>
                  <Input
                    value={displayNameDraft()}
                    onInput={(e) => setDisplayNameDraft(e.currentTarget.value)}
                  />
                </FormField>
                <details class="wb-disclosure wc-advanced-settings">
                  <summary>
                    {t("workspaceSettings.general.advancedDetails")}
                  </summary>
                  <KVList
                    items={[
                      {
                        label: t("workspaceSettings.general.type"),
                        value: <code>{current().type}</code>,
                      },
                      {
                        label: t("workspaceSettings.general.owner"),
                        value: <code>{current().ownerUserId}</code>,
                      },
                    ]}
                  />
                  <div class="wc-form-actions">
                    <Button
                      variant="danger"
                      type="button"
                      busy={archiving()}
                      disabled={archiving() || (workspaces() ?? []).length <= 1}
                      onClick={archive}
                    >
                      {archiving()
                        ? t("common.saving")
                        : t("workspaceSettings.general.archive")}
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
