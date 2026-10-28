/**
 * アカウント > CLI・APIから使う. Keys that let the Takosumi CLI (`--token`)
 * and your own automation act as you. The list leads; the create form opens
 * only when asked for, and the API detail is one plain line of help. A key's
 * secret is shown once, right after it is created.
 */
import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  Show,
  Switch,
} from "solid-js";
import { Check, Copy, KeyRound, Plus } from "lucide-solid";
import {
  type TakosumiAccountsCreatePatResponse,
  type TakosumiAccountsPatMetadata,
  type TakosumiAccountsPatScope,
  type TakosumiAccountsPatScopeCatalogEntry,
} from "@takosjp/takosumi-accounts-contract";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  Checkbox,
  FormField,
  Input,
  Select,
  Skeleton,
  Toast,
} from "../../../components/ui/index.ts";
import RelativeTime from "./RelativeTime.tsx";
import { fetchFailedMessage, friendlyError } from "../../../lib/error-copy.ts";
import { latestOrUndefined } from "../../../lib/resource-read.ts";
import { formatDate, formatDateTime, locale, t } from "../../../i18n/index.ts";
import {
  createTakosumiApiKey,
  listTakosumiApiKeys,
  listTakosumiApiKeyScopeCatalog,
  revokeTakosumiApiKey,
} from "../lib/tokens.ts";

const EXPIRATION_DAYS = [30, 90, 365] as const;

export default function TakosumiApiKeysCard(props: {
  readonly workspaceId?: string;
}) {
  const [keys, { refetch }] = createResource(listTakosumiApiKeys);
  const [scopeCatalog, { refetch: refetchScopeCatalog }] = createResource(
    listTakosumiApiKeyScopeCatalog,
  );
  const [name, setName] = createSignal("");
  const [expirationDays, setExpirationDays] = createSignal(90);
  const [scopes, setScopes] =
    createSignal<readonly TakosumiAccountsPatScope[]>([]);
  const [restrictToWorkspace, setRestrictToWorkspace] = createSignal(true);
  const [created, setCreated] =
    createSignal<TakosumiAccountsCreatePatResponse>();
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [confirmingRevoke, setConfirmingRevoke] = createSignal<string>();
  const [formOpen, setFormOpen] = createSignal(false);
  const scopeCatalogEntries = createMemo(
    (): readonly TakosumiAccountsPatScopeCatalogEntry[] =>
      scopeCatalog.error ? [] : (scopeCatalog.latest?.scopes ?? []),
  );
  const selfServiceScopes = createMemo(() =>
    scopeCatalogEntries().filter((scope) => scope.selfService),
  );
  const selectedScopesRequireWorkspace = createMemo(() => {
    const selected = new Set(scopes());
    return selfServiceScopes().some(
      (scope) =>
        selected.has(scope.scope) && scope.workspaceBinding === "required",
    );
  });

  const toggleScope = (scope: TakosumiAccountsPatScope, checked: boolean) => {
    setScopes((current) =>
      checked
        ? [...new Set([...current, scope])]
        : current.filter((entry) => entry !== scope),
    );
  };

  const create = async () => {
    const normalizedName = name().trim();
    if (
      !normalizedName ||
      scopes().length === 0 ||
      busy() ||
      scopeCatalog.loading ||
      scopeCatalog.error
    ) {
      return;
    }
    if (selectedScopesRequireWorkspace() && !props.workspaceId) {
      setError(t("account.apiKeys.scopeCatalog.workspaceRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    setCopied(false);
    try {
      const result = await createTakosumiApiKey(
        {
          name: normalizedName,
          scopes: scopes(),
          expires_at: new Date(
            Date.now() + expirationDays() * 24 * 60 * 60 * 1_000,
          ).toISOString(),
          ...((restrictToWorkspace() || selectedScopesRequireWorkspace()) &&
          props.workspaceId
            ? { workspace_id: props.workspaceId }
            : {}),
        },
        scopeCatalogEntries(),
      );
      setCreated(result);
      setName("");
      setScopes([]);
      setFormOpen(false);
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
      await revokeTakosumiApiKey(tokenId);
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

  const keyRows = () => latestOrUndefined(keys) ?? [];

  return (
    <div class="acct-stack">
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
            <Show when={!formOpen()}>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={15} />}
                onClick={() => {
                  setFormOpen(true);
                  setCreated(undefined);
                }}
              >
                {t("account.apiKeys.create")}
              </Button>
            </Show>
          }
        />
        <CardSection>
          <p class="acct-help">{t("account.apiKeys.apiHelp")}</p>
        </CardSection>

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

        <Show when={formOpen()}>
          <form
            class="wc-api-key-create"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <p class="acct-help">{t("account.apiKeys.secretOnce")}</p>
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
              hint={t("account.apiKeys.scopesHint")}
              class="wc-api-key-scope-field"
            >
              <Show when={scopeCatalog.loading}>
                <span class="muted">
                  {t("account.apiKeys.scopeCatalog.loading")}
                </span>
              </Show>
              <Show when={scopeCatalog.error}>
                <div class="wc-form-actions" role="alert">
                  <span>{t("account.apiKeys.scopeCatalog.loadFailed")}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    onClick={() => void refetchScopeCatalog()}
                  >
                    {t("account.apiKeys.scopeCatalog.retry")}
                  </Button>
                </div>
              </Show>
              <Show when={!scopeCatalog.loading && !scopeCatalog.error}>
                <Show
                  when={selfServiceScopes().length > 0}
                  fallback={
                    <span class="muted">
                      {t("account.apiKeys.scopeCatalog.empty")}
                    </span>
                  }
                >
                  <div class="wc-api-key-scopes">
                    <For each={selfServiceScopes()}>
                      {(scope) => (
                        <Checkbox
                          label={`${scope.label[locale()]} — ${scope.description[locale()]}`}
                          checked={scopes().includes(scope.scope)}
                          onInput={(event) =>
                            toggleScope(scope.scope, event.currentTarget.checked)
                          }
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </FormField>
            <Show when={props.workspaceId}>
              <Checkbox
                label={t("account.apiKeys.restrictWorkspace")}
                checked={restrictToWorkspace() || selectedScopesRequireWorkspace()}
                disabled={selectedScopesRequireWorkspace()}
                onInput={(event) =>
                  setRestrictToWorkspace(event.currentTarget.checked)
                }
              />
            </Show>
            <Show when={selectedScopesRequireWorkspace() && !props.workspaceId}>
              <span class="wa-error" role="alert">
                {t("account.apiKeys.scopeCatalog.workspaceRequired")}
              </span>
            </Show>
            <div class="wc-form-actions">
              <Button
                variant="primary"
                type="submit"
                icon={<Plus size={15} />}
                busy={busy()}
                disabled={
                  name().trim() === "" ||
                  scopes().length === 0 ||
                  scopeCatalog.loading ||
                  Boolean(scopeCatalog.error) ||
                  (selectedScopesRequireWorkspace() && !props.workspaceId)
                }
              >
                {t("account.apiKeys.createSubmit")}
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setFormOpen(false)}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </form>
        </Show>
      </Card>

      {/* `keys()` throws once the list read has failed; show the failure
          with a retry instead of taking the page down. */}
      <section class="acct-list-section" aria-label={t("account.apiKeys.listLabel")}>
        <h2 class="acct-list-title">{t("account.apiKeys.listLabel")}</h2>
        <Switch>
          <Match when={keys.error}>
            <Toast tone="error">
              <span class="wc-form-actions">
                <span>{fetchFailedMessage(keys.error, t)}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  busy={keys.loading}
                  onClick={() => void refetch()}
                >
                  {t("common.retry")}
                </Button>
              </span>
            </Toast>
          </Match>
          <Match when={keys.loading && !keys.latest}>
            <Skeleton variant="card" count={2} />
          </Match>
          <Match when={keyRows().length === 0}>
            <p class="muted">{t("account.apiKeys.empty")}</p>
          </Match>
          <Match when>
            <ul class="acct-list">
              <For each={keyRows()}>
                {(key) => {
                  const status = () => apiKeyStatus(key);
                  return (
                    <li class="acct-row tg-card">
                      <div class="acct-row-main">
                        <div class="acct-row-title">
                          <strong>{key.name}</strong>
                          <Badge tone={status().tone}>{t(status().label)}</Badge>
                        </div>
                        <div class="acct-row-meta">
                          <span class="acct-key-prefix">{key.prefix}…</span>
                          <span>
                            {key.scopes
                              .map((scope) => scopeLabel(scope, scopeCatalogEntries()))
                              .join(" · ")}
                          </span>
                          <Show when={key.workspace_id}>
                            <span>{t("account.apiKeys.workspaceBound")}</span>
                          </Show>
                          <span>
                            <Show
                              when={key.last_used_at}
                              fallback={t("account.apiKeys.neverUsed")}
                            >
                              {(lastUsed) => (
                                <>
                                  {t("account.apiKeys.lastUsed")}{" "}
                                  <RelativeTime iso={lastUsed()} />
                                </>
                              )}
                            </Show>
                          </span>
                          <span
                            title={
                              key.expires_at
                                ? formatDateTime(key.expires_at)
                                : undefined
                            }
                          >
                            {key.expires_at
                              ? t("account.apiKeys.expires", {
                                  date: formatDate(key.expires_at),
                                })
                              : t("account.apiKeys.noExpiry")}
                          </span>
                        </div>
                      </div>
                      <Show when={isApiKeyActive(key)}>
                        <div class="acct-row-actions">
                          <Show
                            when={confirmingRevoke() === key.id}
                            fallback={
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmingRevoke(key.id)}
                              >
                                {t("account.apiKeys.revoke")}
                              </Button>
                            }
                          >
                            <div class="acct-confirm" role="group">
                              <span>{t("account.apiKeys.revokeConsequence")}</span>
                              <Button
                                variant="danger"
                                size="sm"
                                busy={busy()}
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
                        </div>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Match>
        </Switch>
      </section>
    </div>
  );
}

function scopeLabel(
  scope: TakosumiAccountsPatScope,
  catalog: readonly TakosumiAccountsPatScopeCatalogEntry[],
): string {
  return (
    catalog.find((entry) => entry.scope === scope)?.label[locale()] ?? scope
  );
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
