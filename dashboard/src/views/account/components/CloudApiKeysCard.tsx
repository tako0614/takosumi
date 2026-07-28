import {
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import {
  Check,
  Copy,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-solid";
import type {
  TakosumiAccountsCreatePatResponse,
  TakosumiAccountsPatMetadata,
  TakosumiAccountsPatScope,
} from "@takosjp/takosumi-accounts-contract";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  type Column,
  DataTable,
  FormField,
  Input,
  Select,
  Toast,
} from "../../../components/ui/index.ts";
import { friendlyError } from "../../../lib/error-copy.ts";
import { formatDateTime, t } from "../../../i18n/index.ts";
import {
  createCloudApiKey,
  listCloudApiKeys,
  revokeCloudApiKey,
} from "../lib/tokens.ts";

const EXPIRATION_DAYS = [30, 90, 365] as const;
const AVAILABLE_SCOPES = ["read", "write", "admin"] as const;

export default function CloudApiKeysCard(props: {
  readonly workspaceId?: string;
}) {
  const [keys, { refetch }] = createResource(listCloudApiKeys);
  const [name, setName] = createSignal("");
  const [expirationDays, setExpirationDays] = createSignal(90);
  const [scopes, setScopes] =
    createSignal<readonly TakosumiAccountsPatScope[]>(["read"]);
  const [restrictToWorkspace, setRestrictToWorkspace] = createSignal(true);
  const [created, setCreated] =
    createSignal<TakosumiAccountsCreatePatResponse>();
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [confirmingRevoke, setConfirmingRevoke] = createSignal<string>();

  const columns = createMemo<
    readonly Column<TakosumiAccountsPatMetadata>[]
  >(() => [
    {
      header: t("account.apiKeys.key"),
      cell: (key) => (
        <div class="wc-api-key-identity">
          <strong>{key.name}</strong>
          <code>{key.prefix}…</code>
        </div>
      ),
    },
    {
      header: t("account.apiKeys.access"),
      cell: (key) => (
        <div class="wc-api-key-access">
          <span>{key.scopes.map(scopeLabel).join(" · ")}</span>
          <Show when={key.workspace_id}>
            <span>{t("account.apiKeys.workspaceBound")}</span>
          </Show>
        </div>
      ),
    },
    {
      header: t("account.apiKeys.lastUsed"),
      cell: (key) =>
        key.last_used_at
          ? formatDateTime(key.last_used_at)
          : t("account.apiKeys.neverUsed"),
    },
    {
      header: t("account.apiKeys.status"),
      cell: (key) => {
        const status = apiKeyStatus(key);
        return (
          <div class="wc-api-key-status">
            <Badge tone={status.tone}>{t(status.label)}</Badge>
            <span>
              {key.expires_at
                ? t("account.apiKeys.expires", {
                    date: formatDateTime(key.expires_at),
                  })
                : t("account.apiKeys.noExpiry")}
            </span>
          </div>
        );
      },
    },
    {
      header: t("account.apiKeys.action"),
      align: "right",
      cell: (key) => (
        <Show
          when={isApiKeyActive(key)}
          fallback={<span class="muted">—</span>}
        >
          <Show
            when={confirmingRevoke() === key.id}
            fallback={
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={() => setConfirmingRevoke(key.id)}
              >
                {t("account.apiKeys.revoke")}
              </Button>
            }
          >
            <div class="wc-api-key-revoke">
              <Button
                variant="danger"
                size="sm"
                onClick={() => void revoke(key.id)}
              >
                {t("account.apiKeys.revokeConfirm")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingRevoke(undefined)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </Show>
        </Show>
      ),
    },
  ]);

  const toggleScope = (
    scope: TakosumiAccountsPatScope,
    checked: boolean,
  ) => {
    setScopes((current) =>
      checked
        ? [...new Set([...current, scope])]
        : current.filter((entry) => entry !== scope),
    );
  };

  const create = async () => {
    const normalizedName = name().trim();
    if (!normalizedName || scopes().length === 0 || busy()) return;
    setBusy(true);
    setError(undefined);
    setCopied(false);
    try {
      const result = await createCloudApiKey({
        name: normalizedName,
        scopes: scopes(),
        expires_at: new Date(
          Date.now() + expirationDays() * 24 * 60 * 60 * 1_000,
        ).toISOString(),
        ...(restrictToWorkspace() && props.workspaceId
          ? { workspace_id: props.workspaceId }
          : {}),
      });
      setCreated(result);
      setName("");
      await refetch();
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (tokenId: string) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await revokeCloudApiKey(tokenId);
      setConfirmingRevoke(undefined);
      await refetch();
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setBusy(false);
    }
  };

  const copyCreatedToken = async () => {
    const token = created()?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setError(t("account.apiKeys.copyFailed"));
    }
  };

  return (
    <Card class="wc-api-keys">
      <CardHeader
        title={
          <span class="wc-card-title-with-icon">
            <KeyRound size={18} />
            {t("account.apiKeys.title")}
          </span>
        }
        subtitle={t("account.apiKeys.subtitle")}
        actions={
          <Badge tone="info">
            <ShieldCheck size={13} />
            {t("account.apiKeys.secretOnce")}
          </Badge>
        }
      />

      <Show when={error()}>
        {(message) => (
          <Toast tone="error">
            {t("account.apiKeys.error", { message: message() })}
          </Toast>
        )}
      </Show>

      <Show when={created()}>
        {(result) => (
          <div class="wc-api-key-created" role="status">
            <div>
              <strong>{t("account.apiKeys.created")}</strong>
              <span>{t("account.apiKeys.createdHint")}</span>
            </div>
            <code>{result().token}</code>
            <div class="wc-form-actions">
              <Button
                variant="primary"
                size="sm"
                icon={copied() ? <Check size={14} /> : <Copy size={14} />}
                onClick={() => void copyCreatedToken()}
              >
                {copied()
                  ? t("account.apiKeys.copied")
                  : t("account.apiKeys.copy")}
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
        )}
      </Show>

      <div class="wc-api-key-create">
        <FormField label={t("account.apiKeys.name")} required>
          <Input
            value={name()}
            maxlength={80}
            placeholder={t("account.apiKeys.namePlaceholder")}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </FormField>
        <FormField label={t("account.apiKeys.expiresLabel")}>
          <Select
            value={expirationDays()}
            onInput={(event) =>
              setExpirationDays(Number(event.currentTarget.value))
            }
          >
            <For each={EXPIRATION_DAYS}>
              {(days) => (
                <option value={days}>
                  {t("account.apiKeys.expiresDays", { days })}
                </option>
              )}
            </For>
          </Select>
        </FormField>
        <FormField
          as="group"
          label={t("account.apiKeys.scopes")}
          class="wc-api-key-scope-field"
        >
          <div class="wc-api-key-scopes">
            <For each={AVAILABLE_SCOPES}>
              {(scope) => (
                <Checkbox
                  label={scopeLabel(scope)}
                  checked={scopes().includes(scope)}
                  onInput={(event) =>
                    toggleScope(scope, event.currentTarget.checked)
                  }
                />
              )}
            </For>
          </div>
        </FormField>
        <div class="wc-api-key-create-action">
          <Show when={props.workspaceId}>
            <Checkbox
              label={t("account.apiKeys.restrictWorkspace")}
              checked={restrictToWorkspace()}
              onInput={(event) =>
                setRestrictToWorkspace(event.currentTarget.checked)
              }
            />
          </Show>
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            busy={busy()}
            disabled={name().trim() === "" || scopes().length === 0}
            onClick={() => void create()}
          >
            {t("account.apiKeys.create")}
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns()}
        rows={keys()}
        loading={keys.loading}
        rowKey={(key) => key.id}
        empty={t("account.apiKeys.empty")}
        skeletonRows={2}
      />
    </Card>
  );
}

function scopeLabel(scope: TakosumiAccountsPatScope): string {
  switch (scope) {
    case "read":
      return t("account.apiKeys.scope.read");
    case "write":
      return t("account.apiKeys.scope.write");
    case "admin":
      return t("account.apiKeys.scope.admin");
  }
}

function isApiKeyActive(key: TakosumiAccountsPatMetadata): boolean {
  return (
    !key.revoked_at &&
    (!key.expires_at || Date.parse(key.expires_at) > Date.now())
  );
}

function apiKeyStatus(key: TakosumiAccountsPatMetadata): {
  readonly tone: "ok" | "muted" | "warn";
  readonly label:
    | "account.apiKeys.status.active"
    | "account.apiKeys.status.revoked"
    | "account.apiKeys.status.expired";
} {
  if (key.revoked_at) {
    return { tone: "muted", label: "account.apiKeys.status.revoked" };
  }
  if (key.expires_at && Date.parse(key.expires_at) <= Date.now()) {
    return { tone: "warn", label: "account.apiKeys.status.expired" };
  }
  return { tone: "ok", label: "account.apiKeys.status.active" };
}
