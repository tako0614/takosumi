/** Explicit, server-declared target inputs; applying the Plan remains separate. */
import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import type { CapsuleInstallConfigReAdoptionInputContext } from "takosumi-contract";
import { Button, FormField, Input, Select, Textarea } from "../../components/ui/index.ts";
import { ControlApiError, getCapsuleInstallConfigReAdoptionContext } from "../../lib/control-api.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { buildReAdoptionInputs, initialReAdoptionDrafts, reAdoptionRevisionFromError, type ReAdoptionInputDraft, type ReAdoptionInputDrafts } from "../../lib/re-adoption-inputs.ts";
import { createReAdoptionPlanSubmission } from "../../lib/re-adoption-plan.ts";
import { locale, t } from "../../i18n/index.ts";

function localized(value: { readonly ja?: string; readonly en?: string } | undefined, fallback = ""): string {
  return value?.[locale()] || value?.ja || value?.en || fallback;
}

export default function AppReAdoptionInputs(props: {
  readonly capsuleId: string;
  readonly revisionPlanId: string;
  readonly principalId?: string;
  readonly busy: boolean;
  readonly onReview: (create: () => Promise<string>) => Promise<void>;
  readonly onChanged: () => void;
}): JSX.Element {
  const [context, setContext] = createSignal<CapsuleInstallConfigReAdoptionInputContext>();
  const [drafts, setDrafts] = createSignal<ReAdoptionInputDrafts>({});
  const [reading, setReading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [operation, setOperation] = createSignal<ReturnType<typeof createReAdoptionPlanSubmission>>();
  const [canReplace, setCanReplace] = createSignal(false);
  let alive = true;
  onCleanup(() => { alive = false; });
  const scope = () => [props.capsuleId, props.revisionPlanId, props.principalId] as const;
  const inScope = (held: ReturnType<typeof scope>) => alive && scope().every((value, index) => value === held[index]);
  const [contextScope, setContextScope] = createSignal<ReturnType<typeof scope>>();
  const currentContext = () => contextScope() && inScope(contextScope()!) ? context() : undefined;
  const locked = () => operation() !== undefined;
  const canRead = () => !props.busy && !reading() && (!operation() || canReplace() || operation()?.completedPlanId());
  const read = async () => {
    if (!canRead()) return;
    const held = scope();
    setReading(true);
    setError(undefined);
    try {
      const next = await getCapsuleInstallConfigReAdoptionContext(held[0], held[1]);
      if (!inScope(held)) return;
      setContext(next);
      setContextScope(held);
      setDrafts(initialReAdoptionDrafts(next));
      setOperation(undefined);
      setCanReplace(false);
    } catch (cause) {
      if (inScope(held)) setError(friendlyError(cause, t).message);
    } finally {
      if (inScope(held)) setReading(false);
    }
  };
  const edit = (name: string, update: Partial<ReAdoptionInputDraft>) => {
    if (locked()) return;
    setDrafts(previous => Object.fromEntries(Object.entries(previous).map(([key, value]) =>
      [key, key === name ? { ...value, ...update } : value])));
  };
  const submit = async () => {
    const current = currentContext();
    if (!current || props.busy || reading()) return;
    const answer = buildReAdoptionInputs(current, drafts());
    if (!answer.ok) { setError(t("app.reAdoption.invalid")); return; }
    const held = scope();
    // The page's existing permission/busy gate runs before this callback.
    await props.onReview(async () => {
      let pending = operation();
      if (!pending) {
        pending = createReAdoptionPlanSubmission({
          capsuleId: current.capsuleId,
          sourceId: current.sourceId,
          targetRef: current.targetRef,
          request: {
            baseInstallConfigId: current.baseInstallConfigId,
            sourceSnapshotId: current.sourceSnapshotId,
            reason: "Review declared target user inputs",
            reviewedUserVariables: answer.variables,
            expected: { authorityGuard: current.authorityGuard },
          },
        }, () => inScope(held) && currentContext() === current);
        setOperation(pending);
      }
      try {
        const planId = await pending.submit();
        if (inScope(held)) { setError(undefined); props.onChanged(); }
        return planId;
      } catch (cause) {
        if (inScope(held)) {
          // Only the store's closed no-rebind outcomes permit a new answer.
          // A generic HTTP rejection may follow a committed pointer update.
          setCanReplace(pending.adoptionAcknowledged()
            ? reAdoptionRevisionFromError(cause, current.capsuleId, current.sourceId) !== undefined
            : cause instanceof ControlApiError && cause.status === 409 && cause.code === "failed_precondition" &&
              (cause.reason === "capsule_install_config_rebind_conflict" || cause.reason === "capsule_install_config_rebind_busy"));
          setError(friendlyError(cause, t).message);
        }
        throw cause;
      }
    });
  };
  return (
    <div class="ap-subsection" data-testid="app-target-inputs">
      <h3>{t("app.reAdoption.title")}</h3>
      <p class="ap-muted">{t("app.reAdoption.hint")}</p>
      <Button type="button" variant="secondary" disabled={!canRead()} busy={reading()} onClick={() => void read()}>
        {currentContext() ? t("app.reAdoption.reread") : t("app.reAdoption.read")}
      </Button>
      <Show when={error()}>{message => <p class="wa-error" role="alert">{message()}</p>}</Show>
      <Show when={currentContext()}>{current => (
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <p><code>{current().targetRef}</code> <code>{current().resolvedCommit}</code></p>
          <p class="ap-muted">{t("app.reAdoption.replacement")}</p>
          <Show when={current().blockedReason} fallback={
            <For each={current().variables}>{variable => {
              const draft = () => drafts()[variable.name];
              const label = () => localized(variable.label, variable.name);
              return (
                <FormField as="group" label={label()} required={variable.required} hint={localized(variable.description)}>
                  <Select aria-label={t("app.reAdoption.mode", { name: label() })}
                    value={draft()?.mode} disabled={locked() || props.busy}
                    onChange={event => edit(variable.name, { mode: event.currentTarget.value as ReAdoptionInputDraft["mode"] })}>
                    <Show when={draft()?.mode === "unresolved"}><option value="unresolved">{t("app.reAdoption.unavailable")}</option></Show>
                    <Show when={variable.currentValue.status === "present"}><option value="keep">{t("app.reAdoption.keep")}</option></Show>
                    <option value="set">{t("app.reAdoption.set")}</option>
                    <Show when={!variable.required}><option value="unset">{t("app.reAdoption.unset")}</option></Show>
                  </Select>
                  <Show when={draft()?.mode === "keep" && variable.currentValue.status === "present"}>
                    <output>{variable.currentValue.status === "present" ? JSON.stringify(variable.currentValue.value) : ""}</output>
                  </Show>
                  <Show when={draft()?.mode === "set"}>
                    <Show when={variable.type === "json"} fallback={
                      <Input aria-label={label()} value={draft()?.text ?? ""}
                        disabled={locked() || props.busy} autocomplete="off" spellcheck={false}
                        onInput={event => edit(variable.name, { text: event.currentTarget.value })} />
                    }>
                      <Textarea aria-label={label()} value={draft()?.text ?? ""}
                        disabled={locked() || props.busy} autocomplete="off" spellcheck={false}
                        onInput={event => edit(variable.name, { text: event.currentTarget.value })} />
                    </Show>
                    <Show when={variable.type === "boolean"}><p class="ap-muted">{t("app.reAdoption.boolean")}</p></Show>
                  </Show>
                  <Show when={Object.hasOwn(variable, "defaultValue")}><p class="ap-muted">{t("app.reAdoption.default")}: {JSON.stringify(variable.defaultValue)}</p></Show>
                </FormField>
              );
            }}</For>
          }><p class="wa-error" role="alert">{t("app.reAdoption.blocked")}</p></Show>
          <Show when={locked()}><p role="status">{t("app.reAdoption.pending")}</p></Show>
          <Button type="submit" variant="primary" disabled={props.busy || reading() || Boolean(current().blockedReason) || Boolean(operation()?.completedPlanId())}>
            {locked() ? t("app.reAdoption.resume") : t("app.reAdoption.review")}
          </Button>
        </form>
      )}</Show>
    </div>
  );
}
