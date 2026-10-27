/**
 * Create a workspace for a purpose: separate an environment, or use Takosumi with
 * a team. The form asks only for a name; the dashboard generates the stable
 * API handle and never shows it. Used by the workspace switcher popover and by
 * アカウント > スペース, so both entrances behave the same.
 */
import { createSignal, onMount, Show } from "solid-js";
import { createWorkspace, type Workspace } from "../../../lib/control-api.ts";
import { clearWorkspaceListCache } from "../../../lib/workspace-list.ts";
import { setCurrentWorkspaceId } from "../../../lib/workspace-state.ts";
import {
  newWorkspaceHandle,
  type WorkspacePurpose,
  workspaceTypeForPurpose,
} from "../../../lib/workspace-labels.ts";
import { createAction } from "../lib/action.tsx";
import { t } from "../../../i18n/index.ts";
import { Button } from "../../../components/ui/index.ts";

export default function WorkspaceCreateForm(props: {
  readonly purpose: WorkspacePurpose;
  /** Prefix for element ids; two forms can be mounted at once. */
  readonly idPrefix: string;
  readonly onCreated: (workspace: Workspace, purpose: WorkspacePurpose) => void;
  readonly onCancel?: () => void;
  /** Focus the name field on mount (the switcher popover does). */
  readonly autofocus?: boolean;
}) {
  const [name, setName] = createSignal("");
  let inputRef: HTMLInputElement | undefined;
  onMount(() => {
    if (props.autofocus) queueMicrotask(() => inputRef?.focus());
  });

  const create = createAction(async () => {
    const displayName = name().trim();
    if (!displayName) throw new Error(t("workspace.nameRequired"));
    const workspace = await createWorkspace({
      handle: newWorkspaceHandle(),
      displayName,
      type: workspaceTypeForPurpose(props.purpose),
    });
    clearWorkspaceListCache();
    setCurrentWorkspaceId(workspace.id);
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    setName("");
    props.onCreated(workspace, props.purpose);
    return workspace;
  });

  const inputId = () => `${props.idPrefix}-name`;
  const helpId = () => `${props.idPrefix}-name-help`;
  const errorId = () => `${props.idPrefix}-error`;

  return (
    <form
      class="workspace-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void create.run();
      }}
    >
      <label class="tg-field-label" for={inputId()}>
        {props.purpose === "team"
          ? t("workspace.create.teamNameLabel")
          : t("workspace.create.environmentNameLabel")}
      </label>
      <input
        id={inputId()}
        class="tg-input"
        type="text"
        required
        value={name()}
        onInput={(event) => setName(event.currentTarget.value)}
        placeholder={
          props.purpose === "team"
            ? t("workspace.create.teamPlaceholder")
            : t("workspace.create.environmentPlaceholder")
        }
        aria-describedby={`${helpId()}${create.error() ? ` ${errorId()}` : ""}`}
        autocomplete="off"
        spellcheck={false}
        ref={inputRef}
      />
      <p class="workspace-create-hint" id={helpId()}>
        {props.purpose === "team"
          ? t("workspace.create.teamHelp")
          : t("workspace.create.environmentHelp")}
      </p>
      <div class="workspace-create-actions">
        <Button variant="primary" size="sm" type="submit" busy={create.busy()}>
          {create.busy() ? t("common.creating") : t("workspace.create.submit")}
        </Button>
        <Show when={props.onCancel}>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => props.onCancel?.()}
          >
            {t("common.cancel")}
          </Button>
        </Show>
      </div>
      <Show when={create.error()}>
        {(message) => (
          <p class="workspace-create-error" id={errorId()} role="alert">
            {t("workspace.create.failed", { message: message() })}
          </p>
        )}
      </Show>
    </form>
  );
}
