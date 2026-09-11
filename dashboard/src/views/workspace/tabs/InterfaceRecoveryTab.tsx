/**
 * Workspace settings — durable Interface materialization recovery.
 *
 * This is a narrow operator tool over the existing value-free failure list.
 * A retry always reuses the exact identity observed by the preceding GET; the
 * control plane remains the authority for membership, ownership, and CAS.
 */
import "../../../styles/wave-b.css";
import { A } from "@solidjs/router";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { RefreshCw, RotateCcw } from "lucide-solid";
import {
  type CapsuleInterfaceMaterializationFailure,
  type CapsuleInterfaceMaterializationRetryReceipt,
  ControlApiError,
  INTERFACE_MATERIALIZATION_FAILURE_LIMIT,
  isInterfaceMaterializationRetryStale,
  listInterfaceMaterializationFailures,
  retryInterfaceMaterializationFailure,
} from "../../../lib/control-api.ts";
import { currentWorkspaceId } from "../../../lib/workspace-state.ts";
import { fetchFailedMessage } from "../../../lib/error-copy.ts";
import { formatDateTime, t } from "../../../i18n/index.ts";
import { ActionError, createAction } from "../../account/lib/action.tsx";
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  type Column,
} from "../../../components/ui/index.ts";

export default function InterfaceRecoveryTab(props: {
  readonly workspaceId: string;
}) {
  const [failures, { refetch: refetchFailures }] = createResource(
    () => props.workspaceId,
    (workspaceId) =>
      listInterfaceMaterializationFailures(workspaceId, {
        limit: INTERFACE_MATERIALIZATION_FAILURE_LIMIT,
      }),
  );
  const [retryingId, setRetryingId] = createSignal<string | null>(null);
  const [queuedReceipt, setQueuedReceipt] =
    createSignal<CapsuleInterfaceMaterializationRetryReceipt | null>(null);

  const rows = (): readonly CapsuleInterfaceMaterializationFailure[] =>
    failures.error ? [] : (failures.latest ?? []);

  async function refreshFailureList(): Promise<void> {
    try {
      await refetchFailures();
    } catch {
      // The resource's error state is rendered by this card; a queued or
      // stale mutation message should not be replaced by a refetch failure.
    }
  }

  const retryAction = createAction(
    async (
      failure: CapsuleInterfaceMaterializationFailure,
    ): Promise<CapsuleInterfaceMaterializationRetryReceipt> => {
      const targetWorkspaceId = props.workspaceId;
      try {
        const receipt = await retryInterfaceMaterializationFailure(
          targetWorkspaceId,
          failure.id,
          {
            failureDigest: failure.failureDigest,
            stateVersionId: failure.stateVersionId,
            stateGeneration: failure.stateGeneration,
          },
        );

        // A Workspace switch can happen while the POST is in flight. Never
        // publish the old result into the new Workspace's view or refetch the
        // new scope with a mutation that belonged to the old one.
        if (currentWorkspaceId() !== targetWorkspaceId) return receipt;
        setQueuedReceipt(receipt);
        // Accepted means queued/pending, not completed. Refresh the read-only
        // dead-letter list so the current server projection is authoritative.
        await refreshFailureList();
        return receipt;
      } catch (error) {
        // A stale/deleted observed row is reconciled by one fresh read only;
        // this surface never re-submits the mutation with a new identity.
        if (isInterfaceMaterializationRetryStale(error)) {
          if (currentWorkspaceId() === targetWorkspaceId) {
            await refreshFailureList();
            throw new Error(t("interfaceRecovery.retryStale"));
          }
          throw error;
        }
        if (isForbiddenRetry(error)) {
          throw new Error(t("interfaceRecovery.retryForbidden"));
        }
        // Keep opaque server diagnostics out of this value-free operator
        // surface. The backend's status/code remains in the server logs.
        if (error instanceof ControlApiError) {
          throw new Error(t("interfaceRecovery.retryFailed"));
        }
        throw error;
      }
    },
  );

  const startRetry = (failure: CapsuleInterfaceMaterializationFailure) => {
    if (retryAction.busy()) return;
    setQueuedReceipt(null);
    setRetryingId(failure.id);
    void retryAction.run(failure).finally(() => setRetryingId(null));
  };

  const refresh = () => {
    if (retryAction.busy()) return;
    retryAction.clearError();
    setQueuedReceipt(null);
    void refetchFailures();
  };

  const columns: readonly Column<CapsuleInterfaceMaterializationFailure>[] = [
    {
      header: t("interfaceRecovery.col.capsule"),
      cell: (failure) => (
        <A
          href={`/workloads/${encodeURIComponent(failure.capsuleId)}`}
          title={failure.capsuleId}
        >
          <code>{failure.capsuleId}</code>
        </A>
      ),
    },
    {
      header: t("interfaceRecovery.col.error"),
      cell: (failure) => <code>{failure.error.code}</code>,
    },
    {
      header: t("interfaceRecovery.col.recordedAt"),
      cell: (failure) => (
        <time datetime={failure.error.recordedAt}>
          {formatDateTime(failure.error.recordedAt)}
        </time>
      ),
    },
    {
      header: t("interfaceRecovery.col.progress"),
      cell: (failure) => (
        <span
          aria-label={t("interfaceRecovery.progress", {
            next: failure.nextItemIndex,
            total: failure.totalItems,
          })}
        >
          {failure.nextItemIndex}/{failure.totalItems}
        </span>
      ),
    },
    {
      header: t("interfaceRecovery.col.attempts"),
      align: "right",
      cell: (failure) => failure.attempts,
    },
    {
      header: t("interfaceRecovery.col.actions"),
      align: "right",
      cell: (failure) => (
        <Button
          variant="secondary"
          size="sm"
          type="button"
          icon={<RotateCcw size={14} />}
          busy={retryAction.busy() && retryingId() === failure.id}
          disabled={retryAction.busy()}
          aria-label={t("interfaceRecovery.retryFor", {
            capsule: failure.capsuleId,
          })}
          onClick={() => startRetry(failure)}
        >
          {t("interfaceRecovery.retry")}
        </Button>
      ),
    },
  ];

  return (
    <div class="wb-stack">
      <Card>
        <CardHeader
          title={t("interfaceRecovery.title")}
          subtitle={t("interfaceRecovery.subtitle")}
          actions={
            <Button
              variant="secondary"
              size="sm"
              type="button"
              icon={<RefreshCw size={16} />}
              busy={failures.loading}
              disabled={failures.loading || retryAction.busy()}
              onClick={refresh}
            >
              {t("common.refresh")}
            </Button>
          }
        />
        <ActionError error={retryAction.error} />
        <Show when={queuedReceipt()}>
          {(receipt) => (
            <p class="wb-progress" role="status" aria-live="polite">
              {t("interfaceRecovery.retryQueued", {
                capsule: receipt().capsuleId,
              })}
            </p>
          )}
        </Show>
        <Show when={failures.loading && !failures.latest}>
          <p class="wb-progress" role="status" aria-live="polite">
            {t("common.loading")}
          </p>
        </Show>
        <Switch>
          <Match when={failures.error}>
            <EmptyState
              icon={<RotateCcw size={28} />}
              title={t("interfaceRecovery.title")}
              message={fetchFailedMessage(failures.error, t)}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={refresh}
                >
                  {t("common.retry")}
                </Button>
              }
            />
          </Match>
          <Match when={!failures.error}>
            <Show
              when={failures.loading || rows().length > 0}
              fallback={
                <EmptyState
                  icon={<RotateCcw size={28} />}
                  title={t("interfaceRecovery.empty.title")}
                  message={t("interfaceRecovery.empty.message")}
                  action={
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={refresh}
                    >
                      {t("common.refresh")}
                    </Button>
                  }
                />
              }
            >
              <DataTable
                columns={columns}
                rows={rows()}
                rowKey={(failure) => failure.id}
                loading={failures.loading && !failures.latest}
                skeletonRows={3}
              />
              <Show when={rows().length >= INTERFACE_MATERIALIZATION_FAILURE_LIMIT}>
                <p class="muted" role="note">
                  {t("interfaceRecovery.limitNote")}
                </p>
              </Show>
            </Show>
          </Match>
        </Switch>
      </Card>
    </div>
  );
}

function isForbiddenRetry(error: unknown): boolean {
  return error instanceof ControlApiError && error.status === 403;
}
