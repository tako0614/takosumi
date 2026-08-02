import { Check, Copy, KeyRound, ShieldCheck, Trash2 } from "lucide-solid";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  ControlApiError,
  createS3CustomerAccessKey,
  listS3CustomerAccessKeys,
  revokeS3CustomerAccessKey,
  type S3CustomerAccessKeyCreateResult,
  type S3CustomerAccessKeyMetadata,
  type S3CustomerAccessKeyPermission,
} from "../../../lib/control-api.ts";
import { friendlyError } from "../../../lib/error-copy.ts";
import { formatDateTime, t } from "../../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  Checkbox,
  FormField,
  Input,
  Toast,
} from "../../../components/ui/index.ts";

const PERMISSIONS: readonly S3CustomerAccessKeyPermission[] = [
  "storage.read",
  "storage.list",
  "storage.write",
];

interface Props {
  readonly workspaceId: string;
  readonly resourceId: string;
  readonly resourceName: string;
  readonly interfaceAvailable: boolean;
  readonly interfaceLoading?: boolean;
  readonly interfaceError?: unknown;
}

function idempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto);
  return `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function permissionLabel(permission: S3CustomerAccessKeyPermission): string {
  switch (permission) {
    case "storage.read":
      return t("resources.detail.s3Keys.permission.read");
    case "storage.list":
      return t("resources.detail.s3Keys.permission.list");
    case "storage.write":
      return t("resources.detail.s3Keys.permission.write");
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof ControlApiError) {
    if (cause.status === 403) return t("resources.detail.s3Keys.forbidden");
    if ([404, 501, 503].includes(cause.status)) {
      return t("resources.detail.s3Keys.unavailable");
    }
  }
  return friendlyError(cause, t).message;
}

function matchingGrants(
  key: S3CustomerAccessKeyMetadata,
  resourceId: string,
  resourceName: string,
) {
  return key.grants.filter(
    (grant) =>
      grant.resourceId === resourceId && grant.resourceName === resourceName,
  );
}

function statusTone(status: S3CustomerAccessKeyMetadata["status"]):
  | "ok"
  | "muted" {
  return status === "active" ? "ok" : "muted";
}

function statusLabel(status: S3CustomerAccessKeyMetadata["status"]): string {
  return status === "active"
    ? t("resources.detail.s3Keys.status.active")
    : t("resources.detail.s3Keys.status.revoked");
}

export default function S3CustomerAccessKeysCard(props: Props) {
  const scope = () =>
    props.interfaceAvailable
      ? `${props.workspaceId}\u0000${props.resourceId}`
      : undefined;
  const [keys, { refetch }] = createResource(scope, () =>
    listS3CustomerAccessKeys(props.workspaceId),
  );
  const [label, setLabel] = createSignal("");
  const [permissions, setPermissions] = createSignal<
    readonly S3CustomerAccessKeyPermission[]
  >(["storage.read"]);
  const [created, setCreated] =
    createSignal<S3CustomerAccessKeyCreateResult>();
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal<"create" | string>();
  const [error, setError] = createSignal<string>();
  const [confirmingRevoke, setConfirmingRevoke] = createSignal<string>();

  const scopedKeys = createMemo(() =>
    (keys() ?? []).filter(
      (key) =>
        key.workspaceId === props.workspaceId &&
        matchingGrants(key, props.resourceId, props.resourceName).length > 0,
    ),
  );

  const togglePermission = (
    permission: S3CustomerAccessKeyPermission,
    checked: boolean,
  ) => {
    setPermissions((current) =>
      checked
        ? [...new Set([...current, permission])]
        : current.filter((entry) => entry !== permission),
    );
  };

  const create = async () => {
    const normalizedLabel = label().trim();
    if (
      !normalizedLabel ||
      permissions().length === 0 ||
      busy() ||
      !props.interfaceAvailable
    ) {
      return;
    }
    setBusy("create");
    setError(undefined);
    setCopied(false);
    try {
      const result = await createS3CustomerAccessKey({
        workspaceId: props.workspaceId,
        resourceId: props.resourceId,
        resourceName: props.resourceName,
        label: normalizedLabel,
        permissions: permissions(),
        idempotencyKey: idempotencyKey(),
      });
      setCreated(result);
      setLabel("");
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const revoke = async (keyId: string) => {
    if (busy()) return;
    setBusy(keyId);
    setError(undefined);
    try {
      await revokeS3CustomerAccessKey(props.workspaceId, keyId);
      setConfirmingRevoke(undefined);
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  };

  const copyCreatedCredentials = async () => {
    const credentials = created()?.accessKey.credentials;
    if (!credentials) return;
    const value = `AWS_ACCESS_KEY_ID=${credentials.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${credentials.secretAccessKey}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setError(t("resources.detail.s3Keys.copyFailed"));
    }
  };

  const interfaceUnavailable = () =>
    !props.interfaceLoading && !props.interfaceAvailable;

  return (
    <Card class="rs-s3-key-card">
      <CardHeader
        title={
          <span class="rs-s3-key-title">
            <KeyRound size={18} />
            {t("resources.detail.s3Keys.title")}
          </span>
        }
        subtitle={t("resources.detail.s3Keys.subtitle")}
        actions={
          <Badge tone="info">
            <ShieldCheck size={13} />
            {t("resources.detail.s3Keys.secretOnce")}
          </Badge>
        }
      />

      <Show when={props.interfaceLoading && !props.interfaceAvailable}>
        <CardSection>
          <p class="rs-muted">{t("resources.detail.s3Keys.interfaceLoading")}</p>
        </CardSection>
      </Show>

      <Show when={interfaceUnavailable()}>
        <CardSection>
          <Toast tone="neutral">
            {props.interfaceError
              ? errorMessage(props.interfaceError)
              : t("resources.detail.s3Keys.interfaceUnavailable")}
          </Toast>
        </CardSection>
      </Show>

      <Show when={props.interfaceAvailable}>
        <Show when={error()}>
          {(message) => (
            <CardSection>
              <Toast tone="error">
                {t("resources.detail.s3Keys.error", { message: message() })}
              </Toast>
            </CardSection>
          )}
        </Show>

        <CardSection class="rs-s3-key-scope">
          <div>
            <span class="rs-s3-key-scope-label">
              {t("resources.detail.s3Keys.resource")}
            </span>
            <strong>{props.resourceName}</strong>
          </div>
          <code>{props.resourceId}</code>
        </CardSection>

        <CardSection class="rs-s3-key-create">
          <FormField
            label={t("resources.detail.s3Keys.label")}
            required
          >
            <Input
              value={label()}
              maxlength={80}
              placeholder={t("resources.detail.s3Keys.labelPlaceholder")}
              onInput={(event) => setLabel(event.currentTarget.value)}
            />
          </FormField>
          <FormField
            as="group"
            label={t("resources.detail.s3Keys.permissions")}
            hint={t("resources.detail.s3Keys.permissionsHint")}
          >
            <div class="rs-s3-key-permissions">
              <For each={PERMISSIONS}>
                {(permission) => (
                  <Checkbox
                    checked={permissions().includes(permission)}
                    onChange={(event) =>
                      togglePermission(permission, event.currentTarget.checked)
                    }
                    label={permissionLabel(permission)}
                  />
                )}
              </For>
            </div>
          </FormField>
          <Button
            variant="primary"
            busy={busy() === "create"}
            disabled={
              !label().trim() ||
              permissions().length === 0 ||
              busy() !== undefined
            }
            onClick={() => void create()}
          >
            {busy() === "create"
              ? t("resources.detail.s3Keys.creating")
              : t("resources.detail.s3Keys.create")}
          </Button>
        </CardSection>

        <Show when={created()}>
          {(result) => (
            <CardSection>
              <div class="rs-s3-key-created" role="status">
                <div>
                  <strong>{t("resources.detail.s3Keys.created")}</strong>
                  <span>{t("resources.detail.s3Keys.createdHint")}</span>
                </div>
                <code>{`AWS_ACCESS_KEY_ID=${result().accessKey.credentials.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${result().accessKey.credentials.secretAccessKey}`}</code>
                <div class="rs-s3-key-actions">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={copied() ? <Check size={14} /> : <Copy size={14} />}
                    onClick={() => void copyCreatedCredentials()}
                  >
                    {copied()
                      ? t("resources.detail.s3Keys.copied")
                      : t("resources.detail.s3Keys.copy")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCreated(undefined)}
                  >
                    {t("common.dismiss")}
                  </Button>
                </div>
              </div>
            </CardSection>
          )}
        </Show>

        <CardSection>
          <Show when={keys.error}>
            <Toast tone="error">{errorMessage(keys.error)}</Toast>
          </Show>
          <Show when={!keys.error && keys.loading}>
            <p class="rs-muted">{t("common.loading")}</p>
          </Show>
          <Show
            when={!keys.error && !keys.loading && scopedKeys().length > 0}
            fallback={
              !keys.error && !keys.loading ? (
                <p class="rs-muted">{t("resources.detail.s3Keys.empty")}</p>
              ) : undefined
            }
          >
            <ul class="rs-s3-key-list">
              <For each={scopedKeys()}>
                {(key) => {
                  const grants = () =>
                    matchingGrants(key, props.resourceId, props.resourceName);
                  return (
                    <li>
                      <div class="rs-s3-key-row-main">
                        <div>
                          <strong>{key.label}</strong>
                          <code>{key.accessKeyId}…</code>
                        </div>
                        <Badge tone={statusTone(key.status)}>
                          {statusLabel(key.status)}
                        </Badge>
                      </div>
                      <div class="rs-s3-key-row-meta">
                        <span>
                          {grants()
                            .map((grant) => permissionLabel(grant.permission))
                            .join(" · ")}
                        </span>
                        <span>{formatDateTime(key.createdAt)}</span>
                        <Show when={key.status === "active"}>
                          <Show
                            when={confirmingRevoke() === key.id}
                            fallback={
                              <Button
                                variant="ghost"
                                size="sm"
                                icon={<Trash2 size={14} />}
                                onClick={() => setConfirmingRevoke(key.id)}
                              >
                                {t("resources.detail.s3Keys.revoke")}
                              </Button>
                            }
                          >
                            <div class="rs-s3-key-actions">
                              <Button
                                variant="danger"
                                size="sm"
                                busy={busy() === key.id}
                                onClick={() => void revoke(key.id)}
                              >
                                {t("resources.detail.s3Keys.revokeConfirm")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy() !== undefined}
                                onClick={() => setConfirmingRevoke(undefined)}
                              >
                                {t("common.cancel")}
                              </Button>
                            </div>
                          </Show>
                        </Show>
                      </div>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </CardSection>
      </Show>
    </Card>
  );
}
