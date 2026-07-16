import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
  type JSX,
} from "solid-js";
import { CheckCircle2, Download, Eye, Play } from "lucide-solid";
import {
  applyResourceShape,
  importResourceShape,
  previewResourceShape,
  type ResourceShape,
  type ResourceShapeJsonObject,
  type ResourceShapePreview,
  type ResourceShapeResult,
  type ResourceShapeWriteInput,
} from "../../lib/control-api.ts";
import { formatUsdMicros } from "../../lib/billing-format.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import {
  buildGuidedResourceServiceSpec,
  draftGuidedResourceServiceSpec,
  GUIDED_RESOURCE_SERVICE_KINDS,
  isGuidedResourceServiceKind,
  readGuidedResourceServiceForm,
  type EdgeWorkerArtifactSource,
  type GuidedResourceServiceForm,
  type GuidedResourceServiceKind,
  type GuidedSpecErrorCode,
  type GuidedSpecResult,
  type KVStoreConsistency,
  type ObjectBucketStorageClass,
  type OptionalBooleanChoice,
} from "../../lib/resource-service-form.ts";
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

const BUNDLED_KINDS = GUIDED_RESOURCE_SERVICE_KINDS;

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

type ServiceSelection = GuidedResourceServiceKind | "custom";

export default function ResourceEditor(props: Props): JSX.Element {
  const { confirm } = useConfirmDialog();
  const [guidedMode, setGuidedMode] = createSignal(true);
  const [kind, setKind] = createSignal("EdgeWorker");
  const [name, setName] = createSignal("");
  const [project, setProject] = createSignal("");
  const [environment, setEnvironment] = createSignal("default");
  const [targetPoolName, setTargetPoolName] = createSignal("default");
  const [spacePolicyName, setSpacePolicyName] = createSignal("default");
  const [specText, setSpecText] = createSignal(prettyJson({ name: "" }));
  const [labelsText, setLabelsText] = createSignal(prettyJson({}));
  const [artifactSource, setArtifactSource] =
    createSignal<EdgeWorkerArtifactSource>("url");
  const [artifactUrl, setArtifactUrl] = createSignal("");
  const [artifactRef, setArtifactRef] = createSignal("");
  const [artifactSha256, setArtifactSha256] = createSignal("");
  const [compatibilityDate, setCompatibilityDate] = createSignal("");
  const [compatibilityFlags, setCompatibilityFlags] = createSignal("");
  const [profiles, setProfiles] = createSignal("");
  const [bucketStorageClass, setBucketStorageClass] =
    createSignal<ObjectBucketStorageClass>("standard");
  const [bucketInterfaces, setBucketInterfaces] = createSignal("s3_api");
  const [kvConsistency, setKvConsistency] =
    createSignal<KVStoreConsistency>("");
  const [sqlEngine, setSqlEngine] = createSignal("");
  const [sqlMigrationsPath, setSqlMigrationsPath] = createSignal("");
  const [queueMaxRetries, setQueueMaxRetries] = createSignal("");
  const [queueMaxBatchSize, setQueueMaxBatchSize] = createSignal("");
  const [vectorDimensions, setVectorDimensions] = createSignal("");
  const [vectorMetric, setVectorMetric] = createSignal("");
  const [workflowEntrypoint, setWorkflowEntrypoint] = createSignal("");
  const [workflowMaxAttempts, setWorkflowMaxAttempts] = createSignal("");
  const [workflowBackoff, setWorkflowBackoff] = createSignal("");
  const [containerImage, setContainerImage] = createSignal("");
  const [containerPorts, setContainerPorts] = createSignal("");
  const [containerPublicHttp, setContainerPublicHttp] =
    createSignal<OptionalBooleanChoice>("");
  const [containerEnvironment, setContainerEnvironment] = createSignal("");
  const [actorClassName, setActorClassName] = createSignal("");
  const [actorStorageProfile, setActorStorageProfile] = createSignal("");
  const [actorMigrationTag, setActorMigrationTag] = createSignal("");
  const [scheduleCron, setScheduleCron] = createSignal("");
  const [scheduleTimezone, setScheduleTimezone] = createSignal("UTC");
  const [scheduleConnectionName, setScheduleConnectionName] =
    createSignal("target");
  const [scheduleTargetResource, setScheduleTargetResource] = createSignal("");
  const [nativeId, setNativeId] = createSignal("");
  const [preview, setPreview] = createSignal<ResourceShapePreview>();
  const [previewFingerprint, setPreviewFingerprint] = createSignal<string>();
  const [busy, setBusy] = createSignal<"preview" | "apply" | "import">();
  const [error, setError] = createSignal<string>();
  const [success, setSuccess] = createSignal<string>();

  const guidedForm = (): GuidedResourceServiceForm | undefined => {
    switch (kind()) {
      case "EdgeWorker":
        return {
          kind: "EdgeWorker",
          form: {
            name: name(),
            artifactSource: artifactSource(),
            artifactUrl: artifactUrl(),
            artifactRef: artifactRef(),
            artifactSha256: artifactSha256(),
            compatibilityDate: compatibilityDate(),
            compatibilityFlags: compatibilityFlags(),
            profiles: profiles(),
          },
        };
      case "ObjectBucket":
        return {
          kind: "ObjectBucket",
          form: {
            name: name(),
            storageClass: bucketStorageClass(),
            interfaces: bucketInterfaces(),
          },
        };
      case "KVStore":
        return {
          kind: "KVStore",
          form: { name: name(), consistency: kvConsistency() },
        };
      case "SQLDatabase":
        return {
          kind: "SQLDatabase",
          form: {
            name: name(),
            engine: sqlEngine(),
            migrationsPath: sqlMigrationsPath(),
          },
        };
      case "Queue":
        return {
          kind: "Queue",
          form: {
            name: name(),
            maxRetries: queueMaxRetries(),
            maxBatchSize: queueMaxBatchSize(),
          },
        };
      case "VectorIndex":
        return {
          kind: "VectorIndex",
          form: {
            name: name(),
            dimensions: vectorDimensions(),
            metric: vectorMetric(),
          },
        };
      case "DurableWorkflow":
        return {
          kind: "DurableWorkflow",
          form: {
            name: name(),
            artifactSource: artifactSource(),
            artifactUrl: artifactUrl(),
            artifactRef: artifactRef(),
            artifactSha256: artifactSha256(),
            entrypoint: workflowEntrypoint(),
            maxAttempts: workflowMaxAttempts(),
            initialBackoffSeconds: workflowBackoff(),
          },
        };
      case "ContainerService":
        return {
          kind: "ContainerService",
          form: {
            name: name(),
            image: containerImage(),
            ports: containerPorts(),
            publicHttp: containerPublicHttp(),
            environment: containerEnvironment(),
          },
        };
      case "StatefulActorNamespace":
        return {
          kind: "StatefulActorNamespace",
          form: {
            name: name(),
            className: actorClassName(),
            storageProfile: actorStorageProfile(),
            migrationTag: actorMigrationTag(),
          },
        };
      case "Schedule":
        return {
          kind: "Schedule",
          form: {
            name: name(),
            cron: scheduleCron(),
            timezone: scheduleTimezone(),
            connectionName: scheduleConnectionName(),
            targetResource: scheduleTargetResource(),
          },
        };
      default:
        return undefined;
    }
  };

  const serviceSelection = createMemo<ServiceSelection>(() => {
    const currentKind = kind();
    if (guidedMode() && isGuidedResourceServiceKind(currentKind)) {
      return currentKind;
    }
    return "custom";
  });

  const guidedSpec = createMemo<GuidedSpecResult | undefined>(() => {
    if (!guidedMode()) return undefined;
    const form = guidedForm();
    return form ? buildGuidedResourceServiceSpec(form) : undefined;
  });

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
        setNativeId("");

        const guided = isGuidedResourceServiceKind(resource.kind)
          ? readGuidedResourceServiceForm(
              resource.kind,
              resource.spec,
              resource.metadata.name,
            )
          : undefined;
        if (guided) {
          loadGuidedForm(guided);
          setGuidedMode(true);
        } else {
          // Extra/unknown fields stay lossless: operator-defined and advanced
          // resources are edited through their complete raw spec.
          setGuidedMode(false);
        }
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

    let spec: ResourceShapeJsonObject;
    if (guidedMode()) {
      const result = guidedSpec();
      if (!result) {
        return { ok: false, message: t("resources.editor.kindInvalid") };
      }
      if (!result.ok) {
        return { ok: false, message: guidedSpecErrorMessage(result.code) };
      }
      spec = result.value;
    } else {
      const parsed = parseJsonObjectText(specText());
      if (!parsed.ok) {
        return {
          ok: false,
          message: t("resources.editor.specInvalid", {
            message: parsed.message,
          }),
        };
      }
      spec = parsed.value;
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
        spec,
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

  function loadGuidedForm(input: GuidedResourceServiceForm): void {
    switch (input.kind) {
      case "EdgeWorker": {
        const form = input.form;
        setArtifactSource(form.artifactSource);
        setArtifactUrl(form.artifactUrl);
        setArtifactRef(form.artifactRef);
        setArtifactSha256(form.artifactSha256);
        setCompatibilityDate(form.compatibilityDate);
        setCompatibilityFlags(form.compatibilityFlags);
        setProfiles(form.profiles);
        return;
      }
      case "ObjectBucket":
        setBucketStorageClass(input.form.storageClass);
        setBucketInterfaces(input.form.interfaces);
        return;
      case "KVStore":
        setKvConsistency(input.form.consistency);
        return;
      case "SQLDatabase": {
        const form = input.form;
        setSqlEngine(form.engine);
        setSqlMigrationsPath(form.migrationsPath);
        return;
      }
      case "Queue": {
        const form = input.form;
        setQueueMaxRetries(form.maxRetries);
        setQueueMaxBatchSize(form.maxBatchSize);
        return;
      }
      case "VectorIndex": {
        const form = input.form;
        setVectorDimensions(form.dimensions);
        setVectorMetric(form.metric);
        return;
      }
      case "DurableWorkflow": {
        const form = input.form;
        setArtifactSource(form.artifactSource);
        setArtifactUrl(form.artifactUrl);
        setArtifactRef(form.artifactRef);
        setArtifactSha256(form.artifactSha256);
        setWorkflowEntrypoint(form.entrypoint);
        setWorkflowMaxAttempts(form.maxAttempts);
        setWorkflowBackoff(form.initialBackoffSeconds);
        return;
      }
      case "ContainerService": {
        const form = input.form;
        setContainerImage(form.image);
        setContainerPorts(form.ports);
        setContainerPublicHttp(form.publicHttp);
        setContainerEnvironment(form.environment);
        return;
      }
      case "StatefulActorNamespace": {
        const form = input.form;
        setActorClassName(form.className);
        setActorStorageProfile(form.storageProfile);
        setActorMigrationTag(form.migrationTag);
        return;
      }
      case "Schedule": {
        const form = input.form;
        setScheduleCron(form.cron);
        setScheduleTimezone(form.timezone);
        setScheduleConnectionName(form.connectionName);
        setScheduleTargetResource(form.targetResource);
        return;
      }
    }
  }

  function resetGuidedForm(next: GuidedResourceServiceKind): void {
    switch (next) {
      case "EdgeWorker":
        setArtifactSource("url");
        setArtifactUrl("");
        setArtifactRef("");
        setArtifactSha256("");
        setCompatibilityDate("");
        setCompatibilityFlags("");
        setProfiles("");
        return;
      case "ObjectBucket":
        setBucketStorageClass("standard");
        setBucketInterfaces("s3_api");
        return;
      case "KVStore":
        setKvConsistency("");
        return;
      case "SQLDatabase":
        setSqlEngine("");
        setSqlMigrationsPath("");
        return;
      case "Queue":
        setQueueMaxRetries("");
        setQueueMaxBatchSize("");
        return;
      case "VectorIndex":
        setVectorDimensions("");
        setVectorMetric("");
        return;
      case "DurableWorkflow":
        setArtifactSource("url");
        setArtifactUrl("");
        setArtifactRef("");
        setArtifactSha256("");
        setWorkflowEntrypoint("");
        setWorkflowMaxAttempts("");
        setWorkflowBackoff("");
        return;
      case "ContainerService":
        setContainerImage("");
        setContainerPorts("");
        setContainerPublicHttp("");
        setContainerEnvironment("");
        return;
      case "StatefulActorNamespace":
        setActorClassName("");
        setActorStorageProfile("");
        setActorMigrationTag("");
        return;
      case "Schedule":
        setScheduleCron("");
        setScheduleTimezone("UTC");
        setScheduleConnectionName("target");
        setScheduleTargetResource("");
        return;
    }
  }

  function switchToRawAuthoring(): void {
    const form = guidedForm();
    if (form) setSpecText(prettyJson(draftGuidedResourceServiceSpec(form)));
    setGuidedMode(false);
  }

  function selectService(next: ServiceSelection): void {
    if (next === "custom") {
      switchToRawAuthoring();
      return;
    }
    const previousKind = kind();
    if (!guidedMode() && previousKind === next) {
      const parsed = parseJsonObjectText(specText());
      if (parsed.ok) {
        const existing = readGuidedResourceServiceForm(
          next,
          parsed.value,
          name().trim(),
        );
        if (existing) {
          loadGuidedForm(existing);
          setGuidedMode(true);
          return;
        }
      }
      setError(t("resources.editor.rawCannotGuide"));
      return;
    }
    setKind(next);
    if (previousKind !== next) resetGuidedForm(next);
    setGuidedMode(true);
  }

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
    const reviewedPreview = preview();
    if (!reviewedPreview) {
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
        target: reviewedPreview.selectedTarget,
        price: previewPriceLabel(reviewedPreview),
      }),
      confirmText: t("resources.editor.apply"),
    });
    if (!proceed) return;
    setBusy("apply");
    try {
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

  function guidedSpecErrorMessage(code: GuidedSpecErrorCode): string {
    switch (code) {
      case "artifact_url_required":
        return t("resources.editor.artifactUrlRequired");
      case "artifact_url_https":
        return t("resources.editor.artifactUrlHttps");
      case "artifact_ref_required":
        return t("resources.editor.artifactRefRequired");
      case "artifact_sha256_required":
        return t("resources.editor.artifactShaRequired");
      case "queue_max_retries_invalid":
        return t("resources.editor.queueMaxRetriesInvalid");
      case "queue_max_batch_size_invalid":
        return t("resources.editor.queueMaxBatchSizeInvalid");
      case "container_image_required":
        return t("resources.editor.containerImageRequired");
      case "container_ports_invalid":
        return t("resources.editor.containerPortsInvalid");
      case "container_environment_invalid":
        return t("resources.editor.containerEnvironmentInvalid");
      case "vector_dimensions_invalid":
        return t("resources.editor.vectorDimensionsInvalid");
      case "workflow_entrypoint_required":
        return t("resources.editor.workflowEntrypointRequired");
      case "workflow_max_attempts_invalid":
        return t("resources.editor.workflowMaxAttemptsInvalid");
      case "workflow_backoff_invalid":
        return t("resources.editor.workflowBackoffInvalid");
      case "actor_class_required":
        return t("resources.editor.actorClassRequired");
      case "actor_class_invalid":
        return t("resources.editor.actorClassInvalid");
      case "schedule_cron_required":
        return t("resources.editor.scheduleCronRequired");
      case "schedule_cron_invalid":
        return t("resources.editor.scheduleCronInvalid");
      case "schedule_connection_invalid":
        return t("resources.editor.scheduleConnectionInvalid");
      case "schedule_target_required":
        return t("resources.editor.scheduleTargetRequired");
    }
  }

  function previewPriceLabel(result: ResourceShapePreview): string {
    const quote = result.quote;
    if (!quote) return t("resources.preview.noQuoteShort");
    if (quote.ratingStatus !== "rated") {
      return t("resources.preview.unratedShort");
    }
    return `${formatUsdMicros(quote.estimatedTotalUsdMicros)} ${quote.currency}`;
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
        <section class="rs-service-step" data-step="service">
          <div class="rs-step-heading">
            <span class="rs-step-number">1</span>
            <div>
              <h3>{t("resources.editor.serviceStep")}</h3>
              <p>{t("resources.editor.serviceHint")}</p>
            </div>
          </div>
          <label class="tg-field rs-service-choice">
            <span class="tg-field-label">{t("resources.editor.service")}</span>
            <select
              class="tg-select"
              value={serviceSelection()}
              disabled={Boolean(props.resource)}
              onChange={(event) =>
                selectService(event.currentTarget.value as ServiceSelection)
              }
            >
              <option value="EdgeWorker">
                {t("resources.editor.service.edgeWorker")}
              </option>
              <option value="ObjectBucket">
                {t("resources.editor.service.objectBucket")}
              </option>
              <option value="KVStore">
                {t("resources.editor.service.kvStore")}
              </option>
              <option value="SQLDatabase">
                {t("resources.editor.service.sqlDatabase")}
              </option>
              <option value="Queue">
                {t("resources.editor.service.queue")}
              </option>
              <option value="VectorIndex">
                {t("resources.editor.service.vectorIndex")}
              </option>
              <option value="DurableWorkflow">
                {t("resources.editor.service.durableWorkflow")}
              </option>
              <option value="ContainerService">
                {t("resources.editor.service.containerService")}
              </option>
              <option value="StatefulActorNamespace">
                {t("resources.editor.service.statefulActorNamespace")}
              </option>
              <option value="Schedule">
                {t("resources.editor.service.schedule")}
              </option>
              <option value="custom">
                {t("resources.editor.service.custom")}
              </option>
            </select>
            <Show
              when={serviceSelection() !== "custom"}
              fallback={
                <span class="tg-field-hint">
                  {t("resources.editor.customHint")}
                </span>
              }
            >
              <span class="rs-service-maturity">
                <Badge tone="ok">{t("resources.editor.stable")}</Badge>
                <span class="tg-field-hint">
                  {t("resources.editor.stableHint")}
                </span>
              </span>
            </Show>
          </label>
        </section>

        <section class="rs-service-step" data-step="inputs">
          <div class="rs-step-heading">
            <span class="rs-step-number">2</span>
            <div>
              <h3>{t("resources.editor.inputsStep")}</h3>
              <p>{t("resources.editor.inputsHint")}</p>
            </div>
          </div>
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

          <Show when={guidedMode() && kind() === "EdgeWorker"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.artifactSource")}
                </span>
                <select
                  class="tg-select"
                  value={artifactSource()}
                  onChange={(event) =>
                    setArtifactSource(
                      event.currentTarget.value as EdgeWorkerArtifactSource,
                    )
                  }
                >
                  <option value="url">
                    {t("resources.editor.artifactSource.url")}
                  </option>
                  <option value="ref">
                    {t("resources.editor.artifactSource.ref")}
                  </option>
                </select>
              </label>
              <Show
                when={artifactSource() === "url"}
                fallback={
                  <label class="tg-field">
                    <span class="tg-field-label">
                      {t("resources.editor.artifactRef")}
                    </span>
                    <input
                      class="tg-input"
                      value={artifactRef()}
                      onInput={(event) =>
                        setArtifactRef(event.currentTarget.value)
                      }
                      autocomplete="off"
                    />
                    <span class="tg-field-hint">
                      {t("resources.editor.artifactRefHint")}
                    </span>
                  </label>
                }
              >
                <label class="tg-field">
                  <span class="tg-field-label">
                    {t("resources.editor.artifactUrl")}
                  </span>
                  <input
                    class="tg-input"
                    type="url"
                    value={artifactUrl()}
                    onInput={(event) =>
                      setArtifactUrl(event.currentTarget.value)
                    }
                    autocomplete="off"
                    placeholder="https://example.com/releases/worker.js"
                  />
                  <span class="tg-field-hint">
                    {t("resources.editor.artifactUrlHint")}
                  </span>
                </label>
              </Show>
              <label class="tg-field rs-field-wide">
                <span class="tg-field-label">
                  {t("resources.editor.artifactSha")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={artifactSha256()}
                  onInput={(event) =>
                    setArtifactSha256(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="sha256:…"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.artifactShaHint")}
                </span>
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.compatibilityDate")}
                </span>
                <input
                  class="tg-input"
                  type="date"
                  value={compatibilityDate()}
                  onInput={(event) =>
                    setCompatibilityDate(event.currentTarget.value)
                  }
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.compatibilityFlags")}
                </span>
                <input
                  class="tg-input"
                  value={compatibilityFlags()}
                  onInput={(event) =>
                    setCompatibilityFlags(event.currentTarget.value)
                  }
                  autocomplete="off"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.tokenListHint")}
                </span>
              </label>
              <label class="tg-field rs-field-wide">
                <span class="tg-field-label">
                  {t("resources.editor.profiles")}
                </span>
                <input
                  class="tg-input"
                  value={profiles()}
                  onInput={(event) => setProfiles(event.currentTarget.value)}
                  autocomplete="off"
                  placeholder="workers_bindings, node_compat"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.profilesHint")}
                </span>
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "ObjectBucket"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.bucketStorageClass")}
                </span>
                <select
                  class="tg-select"
                  value={bucketStorageClass()}
                  onChange={(event) =>
                    setBucketStorageClass(
                      event.currentTarget.value as ObjectBucketStorageClass,
                    )
                  }
                >
                  <option value="standard">
                    {t("resources.editor.bucketStorageClass.standard")}
                  </option>
                  <option value="infrequent_access">
                    {t("resources.editor.bucketStorageClass.infrequentAccess")}
                  </option>
                </select>
                <span class="tg-field-hint">
                  {t("resources.editor.bucketStorageClassHint")}
                </span>
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.bucketInterfaces")}
                </span>
                <input
                  class="tg-input"
                  value={bucketInterfaces()}
                  onInput={(event) =>
                    setBucketInterfaces(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="s3_api, signed_url"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.bucketInterfacesHint")}
                </span>
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "KVStore"}>
            <label class="tg-field rs-guided-fields">
              <span class="tg-field-label">
                {t("resources.editor.kvConsistency")}
              </span>
              <select
                class="tg-select"
                value={kvConsistency()}
                onChange={(event) =>
                  setKvConsistency(
                    event.currentTarget.value as KVStoreConsistency,
                  )
                }
              >
                <option value="">
                  {t("resources.editor.operatorDefault")}
                </option>
                <option value="eventual">
                  {t("resources.editor.kvConsistency.eventual")}
                </option>
                <option value="strong">
                  {t("resources.editor.kvConsistency.strong")}
                </option>
              </select>
            </label>
          </Show>

          <Show when={guidedMode() && kind() === "SQLDatabase"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.sqlEngine")}
                </span>
                <input
                  class="tg-input"
                  value={sqlEngine()}
                  onInput={(event) => setSqlEngine(event.currentTarget.value)}
                  autocomplete="off"
                  placeholder="sqlite"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.capabilityTokenHint")}
                </span>
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.sqlMigrationsPath")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={sqlMigrationsPath()}
                  onInput={(event) =>
                    setSqlMigrationsPath(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="migrations"
                />
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "Queue"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.queueMaxRetries")}
                </span>
                <input
                  class="tg-input"
                  type="number"
                  min="0"
                  step="1"
                  value={queueMaxRetries()}
                  onInput={(event) =>
                    setQueueMaxRetries(event.currentTarget.value)
                  }
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.queueMaxBatchSize")}
                </span>
                <input
                  class="tg-input"
                  type="number"
                  min="0"
                  step="1"
                  value={queueMaxBatchSize()}
                  onInput={(event) =>
                    setQueueMaxBatchSize(event.currentTarget.value)
                  }
                />
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "VectorIndex"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.vectorDimensions")}
                </span>
                <input
                  class="tg-input"
                  type="number"
                  min="1"
                  step="1"
                  value={vectorDimensions()}
                  onInput={(event) =>
                    setVectorDimensions(event.currentTarget.value)
                  }
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.vectorMetric")}
                </span>
                <input
                  class="tg-input"
                  value={vectorMetric()}
                  onInput={(event) =>
                    setVectorMetric(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="cosine"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.capabilityTokenHint")}
                </span>
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "DurableWorkflow"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.artifactSource")}
                </span>
                <select
                  class="tg-select"
                  value={artifactSource()}
                  onChange={(event) =>
                    setArtifactSource(
                      event.currentTarget.value as EdgeWorkerArtifactSource,
                    )
                  }
                >
                  <option value="url">
                    {t("resources.editor.artifactSource.url")}
                  </option>
                  <option value="ref">
                    {t("resources.editor.artifactSource.ref")}
                  </option>
                </select>
              </label>
              <Show
                when={artifactSource() === "url"}
                fallback={
                  <label class="tg-field">
                    <span class="tg-field-label">
                      {t("resources.editor.artifactRef")}
                    </span>
                    <input
                      class="tg-input"
                      value={artifactRef()}
                      onInput={(event) =>
                        setArtifactRef(event.currentTarget.value)
                      }
                      autocomplete="off"
                    />
                    <span class="tg-field-hint">
                      {t("resources.editor.artifactRefHint")}
                    </span>
                  </label>
                }
              >
                <label class="tg-field">
                  <span class="tg-field-label">
                    {t("resources.editor.artifactUrl")}
                  </span>
                  <input
                    class="tg-input"
                    type="url"
                    value={artifactUrl()}
                    onInput={(event) =>
                      setArtifactUrl(event.currentTarget.value)
                    }
                    autocomplete="off"
                    placeholder="https://example.com/releases/workflow.js"
                  />
                  <span class="tg-field-hint">
                    {t("resources.editor.artifactUrlHint")}
                  </span>
                </label>
              </Show>
              <label class="tg-field rs-field-wide">
                <span class="tg-field-label">
                  {t("resources.editor.artifactSha")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={artifactSha256()}
                  onInput={(event) =>
                    setArtifactSha256(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="sha256:…"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.artifactShaHint")}
                </span>
              </label>
              <label class="tg-field rs-field-wide">
                <span class="tg-field-label">
                  {t("resources.editor.workflowEntrypoint")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={workflowEntrypoint()}
                  onInput={(event) =>
                    setWorkflowEntrypoint(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="run"
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.workflowMaxAttempts")}
                </span>
                <input
                  class="tg-input"
                  type="number"
                  min="1"
                  step="1"
                  value={workflowMaxAttempts()}
                  onInput={(event) =>
                    setWorkflowMaxAttempts(event.currentTarget.value)
                  }
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.workflowBackoff")}
                </span>
                <input
                  class="tg-input"
                  type="number"
                  min="0"
                  step="1"
                  value={workflowBackoff()}
                  onInput={(event) =>
                    setWorkflowBackoff(event.currentTarget.value)
                  }
                />
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "ContainerService"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field rs-field-wide">
                <span class="tg-field-label">
                  {t("resources.editor.containerImage")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={containerImage()}
                  onInput={(event) =>
                    setContainerImage(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="registry.example.com/team/app@sha256:…"
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.containerPorts")}
                </span>
                <input
                  class="tg-input"
                  value={containerPorts()}
                  onInput={(event) =>
                    setContainerPorts(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="8080, 9090"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.integerListHint")}
                </span>
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.containerPublicHttp")}
                </span>
                <select
                  class="tg-select"
                  value={containerPublicHttp()}
                  onChange={(event) =>
                    setContainerPublicHttp(
                      event.currentTarget.value as OptionalBooleanChoice,
                    )
                  }
                >
                  <option value="">
                    {t("resources.editor.operatorDefault")}
                  </option>
                  <option value="true">
                    {t("resources.editor.containerPublicHttp.enabled")}
                  </option>
                  <option value="false">
                    {t("resources.editor.containerPublicHttp.disabled")}
                  </option>
                </select>
              </label>
              <label class="tg-field rs-field-wide">
                <span class="tg-field-label">
                  {t("resources.editor.containerEnvironment")}
                </span>
                <textarea
                  class="tg-textarea rs-code-editor"
                  value={containerEnvironment()}
                  rows={5}
                  spellcheck={false}
                  onInput={(event) =>
                    setContainerEnvironment(event.currentTarget.value)
                  }
                />
                <span class="tg-field-hint">
                  {t("resources.editor.containerEnvironmentHint")}
                </span>
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "StatefulActorNamespace"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.actorClass")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={actorClassName()}
                  onInput={(event) =>
                    setActorClassName(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="ChatRoom"
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.actorStorageProfile")}
                </span>
                <input
                  class="tg-input"
                  value={actorStorageProfile()}
                  onInput={(event) =>
                    setActorStorageProfile(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="durable_sqlite"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.capabilityTokenHint")}
                </span>
              </label>
              <label class="tg-field rs-field-wide">
                <span class="tg-field-label">
                  {t("resources.editor.actorMigrationTag")}
                </span>
                <input
                  class="tg-input"
                  value={actorMigrationTag()}
                  onInput={(event) =>
                    setActorMigrationTag(event.currentTarget.value)
                  }
                  autocomplete="off"
                />
              </label>
            </div>
          </Show>

          <Show when={guidedMode() && kind() === "Schedule"}>
            <div class="rs-form-grid rs-guided-fields">
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.scheduleCron")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={scheduleCron()}
                  onInput={(event) =>
                    setScheduleCron(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="0 * * * *"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.scheduleCronHint")}
                </span>
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.scheduleTimezone")}
                </span>
                <input
                  class="tg-input"
                  value={scheduleTimezone()}
                  onInput={(event) =>
                    setScheduleTimezone(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="UTC"
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.scheduleConnection")}
                </span>
                <input
                  class="tg-input"
                  value={scheduleConnectionName()}
                  onInput={(event) =>
                    setScheduleConnectionName(event.currentTarget.value)
                  }
                  autocomplete="off"
                />
              </label>
              <label class="tg-field">
                <span class="tg-field-label">
                  {t("resources.editor.scheduleTarget")}
                </span>
                <input
                  class="tg-input rs-mono-input"
                  value={scheduleTargetResource()}
                  onInput={(event) =>
                    setScheduleTargetResource(event.currentTarget.value)
                  }
                  autocomplete="off"
                  placeholder="EdgeWorker/api"
                />
                <span class="tg-field-hint">
                  {t("resources.editor.scheduleTargetHint")}
                </span>
              </label>
            </div>
          </Show>
        </section>

        <details class="rs-advanced" open={!guidedMode()}>
          <summary>{t("resources.editor.advanced")}</summary>
          <p class="rs-advanced-intro">{t("resources.editor.advancedHint")}</p>
          <div class="rs-form-grid">
            <label class="tg-field">
              <span class="tg-field-label">
                {t("resources.editor.project")}
              </span>
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

          <Show
            when={!guidedMode()}
            fallback={
              <div class="rs-raw-opt-in">
                <p>{t("resources.editor.rawOptInHint")}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={switchToRawAuthoring}
                >
                  {t("resources.editor.useRawSpec")}
                </Button>
              </div>
            }
          >
            <div class="rs-raw-authoring">
              <p class="rs-raw-warning">{t("resources.editor.rawWarning")}</p>
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
                <span class="tg-field-hint">
                  {t("resources.editor.kindHint")}
                </span>
              </label>
              <label class="tg-field rs-json-field">
                <span class="tg-field-label">{t("resources.editor.spec")}</span>
                <textarea
                  class="tg-textarea rs-code-editor"
                  value={specText()}
                  rows={12}
                  spellcheck={false}
                  onInput={(event) => setSpecText(event.currentTarget.value)}
                />
                <span class="tg-field-hint">
                  {t("resources.editor.specHint")}
                </span>
              </label>
            </div>
          </Show>
        </details>

        <section class="rs-service-step rs-preview-action" data-step="preview">
          <div class="rs-step-heading">
            <span class="rs-step-number">3</span>
            <div>
              <h3>{t("resources.editor.previewStep")}</h3>
              <p>{t("resources.editor.previewHint")}</p>
            </div>
          </div>
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
        </section>

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

            <div class="rs-price-review">
              <p class="rs-price-label">{t("resources.preview.price")}</p>
              <Show
                when={result().quote}
                fallback={
                  <div>
                    <strong>{t("resources.preview.noQuoteShort")}</strong>
                    <p>{t("resources.preview.noQuote")}</p>
                  </div>
                }
              >
                {(quote) => (
                  <div>
                    <strong class="rs-price-value">
                      {quote().ratingStatus === "rated"
                        ? `${formatUsdMicros(quote().estimatedTotalUsdMicros)} ${quote().currency}`
                        : t("resources.preview.unratedShort")}
                    </strong>
                    <p>
                      {quote().ratingStatus === "rated"
                        ? t("resources.preview.ratedHint")
                        : t("resources.preview.unrated")}
                    </p>
                    <dl class="tg-kv rs-quote-evidence">
                      <dt>{t("resources.preview.quote")}</dt>
                      <dd>
                        <code>{quote().quoteId}</code>
                      </dd>
                      <Show when={quote().catalogId && quote().catalogVersion}>
                        <dt>{t("resources.preview.catalog")}</dt>
                        <dd>
                          <code>
                            {quote().catalogId}@{quote().catalogVersion}
                          </code>
                        </dd>
                      </Show>
                      <Show
                        when={quote().offeringId && quote().offeringVersion}
                      >
                        <dt>{t("resources.preview.offering")}</dt>
                        <dd>
                          <code>
                            {quote().offeringId}@{quote().offeringVersion}
                          </code>
                        </dd>
                      </Show>
                      <Show when={quote().region}>
                        <dt>{t("resources.preview.region")}</dt>
                        <dd>{quote().region}</dd>
                      </Show>
                      <dt>{t("resources.preview.priceExpires")}</dt>
                      <dd>{quote().expiresAt}</dd>
                    </dl>
                    <Show when={quote().lineItems.length > 0}>
                      <div class="rs-quote-lines">
                        <p class="rs-price-label">
                          {t("resources.preview.lineItems")}
                        </p>
                        <ul class="rs-compact-list">
                          <For each={quote().lineItems}>
                            {(line) => (
                              <li>
                                <strong>
                                  {line.invoiceDescription ??
                                    line.description ??
                                    line.meterId ??
                                    line.sku}
                                </strong>
                                <span>
                                  {line.sku}@{line.skuVersion} · {line.quantity}{" "}
                                  {line.unit} ·{" "}
                                  {t("resources.preview.unitPrice")}{" "}
                                  {formatUsdMicros(line.unitPriceUsdMicros)} USD
                                  /{line.billingUnit ?? 1} {line.unit} ·{" "}
                                  {t("resources.preview.subtotal")}{" "}
                                  {formatUsdMicros(line.amountUsdMicros)} USD
                                  {line.taxTreatment
                                    ? ` · ${t("resources.preview.tax")}: ${line.taxTreatment}`
                                    : ""}
                                </span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </div>
                )}
              </Show>
            </div>

            <details class="rs-advanced rs-preview-details">
              <summary>{t("resources.preview.technicalDetails")}</summary>
              <dl class="tg-kv rs-preview-kv">
                <dt>{t("resources.preview.target")}</dt>
                <dd>{result().selectedTarget}</dd>
                <dt>{t("resources.preview.implementation")}</dt>
                <dd>{result().selectedImplementation}</dd>
                <dt>{t("resources.preview.portability")}</dt>
                <dd>{result().portability}</dd>
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
            </details>

            <section class="rs-deploy-review" data-step="deploy">
              <div class="rs-step-heading">
                <span class="rs-step-number">4</span>
                <div>
                  <h3>{t("resources.editor.deployStep")}</h3>
                  <p>{t("resources.editor.deployHint")}</p>
                </div>
              </div>
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
            </section>

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
