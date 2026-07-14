import {
  createMemo,
  createSignal,
  on,
  createEffect,
  For,
  Show,
  type JSX,
} from "solid-js";
import { CheckCircle2, Download, Eye, Play } from "lucide-solid";
import {
  applyResourceShape,
  importResourceShape,
  previewResourceShape,
  type ResourceShape,
  type ResourceShapePreview,
  type ResourceShapeResult,
  type ResourceShapeWriteInput,
} from "../../lib/control-api.ts";
import { formatUsdMicros } from "../../lib/billing-format.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import {
  parseJsonObjectText,
  parseStringMapText,
  prettyJson,
  resourceShapeInputFingerprint,
} from "../../lib/resource-shapes.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  Toast,
} from "../../components/ui/index.ts";

const BUNDLED_KINDS = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "Queue",
  "SQLDatabase",
  "ContainerService",
] as const;

type Props = {
  readonly workspaceId: string;
  readonly space: string;
  readonly resource?: ResourceShape;
  readonly onApplied?: (resource: ResourceShapeResult) => void | Promise<void>;
  readonly onCancel?: () => void;
};

type ParsedInput =
  | { readonly ok: true; readonly value: ResourceShapeWriteInput }
  | { readonly ok: false; readonly message: string };

export default function ResourceEditor(props: Props): JSX.Element {
  const { confirm } = useConfirmDialog();
  const [kind, setKind] = createSignal("EdgeWorker");
  const [name, setName] = createSignal("");
  const [project, setProject] = createSignal("");
  const [environment, setEnvironment] = createSignal("default");
  const [targetPoolName, setTargetPoolName] = createSignal("default");
  const [spacePolicyName, setSpacePolicyName] = createSignal("default");
  const [specText, setSpecText] = createSignal(prettyJson({ name: "" }));
  const [labelsText, setLabelsText] = createSignal(prettyJson({}));
  const [nativeId, setNativeId] = createSignal("");
  const [preview, setPreview] = createSignal<ResourceShapePreview>();
  const [previewFingerprint, setPreviewFingerprint] = createSignal<string>();
  const [busy, setBusy] = createSignal<"preview" | "apply" | "import">();
  const [error, setError] = createSignal<string>();
  const [success, setSuccess] = createSignal<string>();

  createEffect(
    on(
      () => props.resource,
      (resource) => {
        if (!resource) return;
        setKind(resource.kind);
        setName(resource.metadata.name);
        setProject(resource.metadata.project ?? "");
        setEnvironment(resource.metadata.environment ?? "default");
        setSpecText(prettyJson(resource.spec));
        setLabelsText(prettyJson(resource.metadata.labels ?? {}));
        setPreview(undefined);
        setPreviewFingerprint(undefined);
      },
    ),
  );

  const parsedInput = createMemo<ParsedInput>(() => {
    const normalizedKind = kind().trim();
    const normalizedName = name().trim();
    if (
      !normalizedKind ||
      !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(normalizedKind)
    ) {
      return { ok: false, message: t("resources.editor.kindInvalid") };
    }
    if (!normalizedName) {
      return { ok: false, message: t("resources.editor.nameRequired") };
    }
    if (!props.space.trim()) {
      return { ok: false, message: t("resources.scope.required") };
    }
    const spec = parseJsonObjectText(specText());
    if (!spec.ok) {
      return {
        ok: false,
        message: t("resources.editor.specInvalid", { message: spec.message }),
      };
    }
    const labels = parseStringMapText(labelsText());
    if (!labels.ok) {
      return {
        ok: false,
        message: t("resources.editor.labelsInvalid", {
          message: labels.message,
        }),
      };
    }
    return {
      ok: true,
      value: {
        workspaceId: props.workspaceId,
        space: props.space.trim(),
        kind: normalizedKind,
        name: normalizedName,
        spec: spec.value,
        ...(project().trim() ? { project: project().trim() } : {}),
        ...(environment().trim() ? { environment: environment().trim() } : {}),
        ...(Object.keys(labels.value).length > 0
          ? { labels: labels.value }
          : {}),
        ...(targetPoolName().trim()
          ? { targetPoolName: targetPoolName().trim() }
          : {}),
        ...(spacePolicyName().trim()
          ? { spacePolicyName: spacePolicyName().trim() }
          : {}),
      },
    };
  });

  const previewIsCurrent = createMemo(() => {
    const input = parsedInput();
    return (
      input.ok &&
      previewFingerprint() === resourceShapeInputFingerprint(input.value)
    );
  });

  function clearFeedback(): void {
    setError(undefined);
    setSuccess(undefined);
  }

  async function runPreview(): Promise<void> {
    clearFeedback();
    const input = parsedInput();
    if (!input.ok) {
      setError(input.message);
      return;
    }
    setBusy("preview");
    try {
      const result = await previewResourceShape(input.value);
      setPreview(result);
      setPreviewFingerprint(resourceShapeInputFingerprint(input.value));
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function runApply(): Promise<void> {
    clearFeedback();
    const input = parsedInput();
    if (!input.ok) {
      setError(input.message);
      return;
    }
    if (!previewIsCurrent()) {
      setError(t("resources.editor.previewRequired"));
      return;
    }
    const proceed = await confirm({
      title: props.resource
        ? t("resources.confirm.updateTitle")
        : t("resources.confirm.applyTitle"),
      message: t("resources.confirm.applyMessage", {
        kind: input.value.kind,
        name: input.value.name,
        target: preview()?.selectedTarget ?? t("common.unknown"),
      }),
      confirmText: t("resources.editor.apply"),
    });
    if (!proceed) return;
    setBusy("apply");
    try {
      const reviewedPreview = preview();
      if (!reviewedPreview) {
        setError(t("resources.editor.previewRequired"));
        return;
      }
      const result = await applyResourceShape(input.value, {
        planDigest: reviewedPreview.planDigest,
        ...(reviewedPreview.quote
          ? {
              quoteId: reviewedPreview.quote.quoteId,
              quoteDigest: reviewedPreview.quote.quoteDigest,
            }
          : {}),
      });
      setSuccess(t("resources.editor.applied"));
      await props.onApplied?.(result);
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function runImport(): Promise<void> {
    clearFeedback();
    const input = parsedInput();
    if (!input.ok) {
      setError(input.message);
      return;
    }
    if (!previewIsCurrent()) {
      setError(t("resources.editor.previewRequired"));
      return;
    }
    if (!nativeId().trim()) {
      setError(t("resources.editor.nativeIdRequired"));
      return;
    }
    const proceed = await confirm({
      title: t("resources.confirm.importTitle"),
      message: t("resources.confirm.importMessage", {
        nativeId: nativeId().trim(),
        kind: input.value.kind,
        name: input.value.name,
      }),
      confirmText: t("resources.editor.import"),
    });
    if (!proceed) return;
    setBusy("import");
    try {
      const result = await importResourceShape({
        ...input.value,
        nativeId: nativeId().trim(),
      });
      setSuccess(t("resources.editor.imported"));
      await props.onApplied?.(result);
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Card class="rs-editor">
      <CardHeader
        title={
          props.resource
            ? t("resources.editor.editTitle")
            : t("resources.editor.createTitle")
        }
        subtitle={t("resources.editor.subtitle")}
        actions={
          props.onCancel ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.onCancel}
            >
              {t("common.cancel")}
            </Button>
          ) : undefined
        }
      />
      <CardSection>
        <div class="rs-form-grid">
          <label class="tg-field">
            <span class="tg-field-label">{t("resources.editor.kind")}</span>
            <input
              class="tg-input"
              list="rs-resource-kinds"
              value={kind()}
              disabled={Boolean(props.resource)}
              onInput={(event) => setKind(event.currentTarget.value)}
            />
            <datalist id="rs-resource-kinds">
              <For each={BUNDLED_KINDS}>
                {(item) => <option value={item} />}
              </For>
            </datalist>
            <span class="tg-field-hint">{t("resources.editor.kindHint")}</span>
          </label>
          <label class="tg-field">
            <span class="tg-field-label">{t("resources.editor.name")}</span>
            <input
              class="tg-input"
              value={name()}
              disabled={Boolean(props.resource)}
              onInput={(event) => setName(event.currentTarget.value)}
              autocomplete="off"
            />
          </label>
          <label class="tg-field">
            <span class="tg-field-label">{t("resources.editor.project")}</span>
            <input
              class="tg-input"
              value={project()}
              onInput={(event) => setProject(event.currentTarget.value)}
              autocomplete="off"
            />
          </label>
          <label class="tg-field">
            <span class="tg-field-label">
              {t("resources.editor.environment")}
            </span>
            <input
              class="tg-input"
              value={environment()}
              onInput={(event) => setEnvironment(event.currentTarget.value)}
              autocomplete="off"
            />
          </label>
        </div>
        <label class="tg-field rs-json-field">
          <span class="tg-field-label">{t("resources.editor.spec")}</span>
          <textarea
            class="tg-textarea rs-code-editor"
            value={specText()}
            rows={12}
            spellcheck={false}
            onInput={(event) => setSpecText(event.currentTarget.value)}
          />
          <span class="tg-field-hint">{t("resources.editor.specHint")}</span>
        </label>
        <details class="rs-advanced">
          <summary>{t("resources.editor.advanced")}</summary>
          <div class="rs-form-grid">
            <label class="tg-field">
              <span class="tg-field-label">
                {t("resources.editor.targetPool")}
              </span>
              <input
                class="tg-input"
                value={targetPoolName()}
                onInput={(event) =>
                  setTargetPoolName(event.currentTarget.value)
                }
                autocomplete="off"
              />
            </label>
            <label class="tg-field">
              <span class="tg-field-label">{t("resources.editor.policy")}</span>
              <input
                class="tg-input"
                value={spacePolicyName()}
                onInput={(event) =>
                  setSpacePolicyName(event.currentTarget.value)
                }
                autocomplete="off"
              />
            </label>
          </div>
          <label class="tg-field rs-json-field">
            <span class="tg-field-label">{t("resources.editor.labels")}</span>
            <textarea
              class="tg-textarea rs-code-editor"
              value={labelsText()}
              rows={5}
              spellcheck={false}
              onInput={(event) => setLabelsText(event.currentTarget.value)}
            />
            <span class="tg-field-hint">
              {t("resources.editor.labelsHint")}
            </span>
          </label>
        </details>
        <div class="rs-editor-actions">
          <Button
            type="button"
            variant="secondary"
            icon={<Eye size={16} />}
            busy={busy() === "preview"}
            disabled={busy() !== undefined}
            onClick={() => void runPreview()}
          >
            {t("resources.editor.preview")}
          </Button>
          <Button
            type="button"
            variant="primary"
            icon={<Play size={16} />}
            busy={busy() === "apply"}
            disabled={busy() !== undefined || !previewIsCurrent()}
            onClick={() => void runApply()}
          >
            {t("resources.editor.apply")}
          </Button>
        </div>
        <Show when={error()}>
          {(message) => <Toast tone="error">{message()}</Toast>}
        </Show>
        <Show when={success()}>
          {(message) => <Toast tone="success">{message()}</Toast>}
        </Show>
      </CardSection>

      <Show when={preview()}>
        {(result) => (
          <CardSection class="rs-preview">
            <div class="rs-section-heading">
              <span class="rs-section-icon" aria-hidden="true">
                <CheckCircle2 size={18} />
              </span>
              <div>
                <h3>{t("resources.preview.title")}</h3>
                <p>{result().summary}</p>
              </div>
              <Badge tone={previewIsCurrent() ? "ok" : "warn"}>
                {previewIsCurrent()
                  ? t("resources.preview.current")
                  : t("resources.preview.changed")}
              </Badge>
            </div>
            <dl class="tg-kv rs-preview-kv">
              <dt>{t("resources.preview.target")}</dt>
              <dd>{result().selectedTarget}</dd>
              <dt>{t("resources.preview.implementation")}</dt>
              <dd>{result().selectedImplementation}</dd>
              <dt>{t("resources.preview.portability")}</dt>
              <dd>{result().portability}</dd>
              <Show when={result().quote}>
                {(quote) => (
                  <>
                    <dt>{t("resources.preview.price")}</dt>
                    <dd>
                      {formatUsdMicros(quote().estimatedTotalUsdMicros)}{" "}
                      {quote().currency}
                    </dd>
                    <dt>{t("resources.preview.priceExpires")}</dt>
                    <dd>{quote().expiresAt}</dd>
                  </>
                )}
              </Show>
              <dt>{t("resources.preview.nativePlan")}</dt>
              <dd>
                <Show
                  when={result().nativeResourcePlan.length > 0}
                  fallback={t("common.none")}
                >
                  <For each={result().nativeResourcePlan}>
                    {(item) => (
                      <code>
                        {item.type}/{item.id}{" "}
                      </code>
                    )}
                  </For>
                </Show>
              </dd>
              <dt>{t("resources.preview.risks")}</dt>
              <dd>
                <Show
                  when={result().riskNotes.length > 0}
                  fallback={t("resources.preview.noRisks")}
                >
                  <ul class="rs-compact-list">
                    <For each={result().riskNotes}>
                      {(note) => <li>{note}</li>}
                    </For>
                  </ul>
                </Show>
              </dd>
            </dl>

            <details class="rs-advanced">
              <summary>{t("resources.editor.importExisting")}</summary>
              <div class="rs-import-row">
                <label class="tg-field">
                  <span class="tg-field-label">
                    {t("resources.editor.nativeId")}
                  </span>
                  <input
                    class="tg-input"
                    value={nativeId()}
                    onInput={(event) => setNativeId(event.currentTarget.value)}
                    autocomplete="off"
                  />
                  <span class="tg-field-hint">
                    {t("resources.editor.nativeIdHint")}
                  </span>
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Download size={16} />}
                  busy={busy() === "import"}
                  disabled={busy() !== undefined || !previewIsCurrent()}
                  onClick={() => void runImport()}
                >
                  {t("resources.editor.import")}
                </Button>
              </div>
            </details>
          </CardSection>
        )}
      </Show>
    </Card>
  );
}
