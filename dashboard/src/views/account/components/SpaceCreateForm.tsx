/**
 * Create a space for a purpose: separate an environment, or use Takosumi with
 * a team. The form asks only for a name; the dashboard generates the stable
 * API handle and never shows it. Used by the space switcher popover and by
 * アカウント > スペース, so both entrances behave the same.
 */
import { createSignal, onMount, Show } from "solid-js";
import { createWorkspace, type Workspace } from "../../../lib/control-api.ts";
import { clearWorkspaceListCache } from "../../../lib/workspace-list.ts";
import { setCurrentWorkspaceId } from "../../../lib/workspace-state.ts";
import {
  newSpaceHandle,
  type SpacePurpose,
  workspaceTypeForPurpose,
} from "../../../lib/space-labels.ts";
import { createAction } from "../lib/action.tsx";
import { t } from "../../../i18n/index.ts";
import { Button } from "../../../components/ui/index.ts";

export default function SpaceCreateForm(props: {
  readonly purpose: SpacePurpose;
  /** Prefix for element ids; two forms can be mounted at once. */
  readonly idPrefix: string;
  readonly onCreated: (workspace: Workspace, purpose: SpacePurpose) => void;
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
    if (!displayName) throw new Error(t("space.nameRequired"));
    const workspace = await createWorkspace({
      handle: newSpaceHandle(),
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
      class="space-create-form"
      onSubmit={(event) => {
        event.preventDefault();
        void create.run();
      }}
    >
      <label class="tg-field-label" for={inputId()}>
        {props.purpose === "team"
          ? t("space.create.teamNameLabel")
          : t("space.create.environmentNameLabel")}
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
            ? t("space.create.teamPlaceholder")
            : t("space.create.environmentPlaceholder")
        }
        aria-describedby={`${helpId()}${create.error() ? ` ${errorId()}` : ""}`}
        autocomplete="off"
        spellcheck={false}
        ref={inputRef}
      />
      <p class="space-create-hint" id={helpId()}>
        {props.purpose === "team"
          ? t("space.create.teamHelp")
          : t("space.create.environmentHelp")}
      </p>
      <div class="space-create-actions">
        <Button variant="primary" size="sm" type="submit" busy={create.busy()}>
          {create.busy() ? t("common.creating") : t("space.create.submit")}
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
          <p class="space-create-error" id={errorId()} role="alert">
            {t("space.create.failed", { message: message() })}
          </p>
        )}
      </Show>
    </form>
  );
}
