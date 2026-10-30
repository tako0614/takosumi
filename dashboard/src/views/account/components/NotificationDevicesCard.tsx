/**
 * アカウント > 通知を受け取る端末. The phones (Takosumi Mobile) registered to
 * receive this instance's own notifications: approval waits, failed Runs and
 * the like. Each can be removed; one whose last send failed is marked so the
 * owner knows to open the app again or remove it.
 */
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { BellRing } from "lucide-solid";
import type { TakosumiAccountsNotificationPusher } from "@takosjp/takosumi-accounts-contract";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  Skeleton,
  Toast,
} from "../../../components/ui/index.ts";
import RelativeTime from "./RelativeTime.tsx";
import { fetchFailedMessage, friendlyError } from "../../../lib/error-copy.ts";
import { latestOrUndefined } from "../../../lib/resource-read.ts";
import { formatDate, type MessageKey, t } from "../../../i18n/index.ts";
import {
  deleteNotificationPusher,
  listNotificationPushers,
  notificationPusherHealth,
} from "../lib/notification-pushers.ts";

export default function NotificationDevicesCard() {
  const [list, { refetch }] = createResource(listNotificationPushers);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [confirming, setConfirming] = createSignal<string>();

  const remove = async (pusherId: string) => {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      await deleteNotificationPusher(pusherId);
      setConfirming(undefined);
      await refetch();
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setBusy(false);
    }
  };

  const rows = (): readonly TakosumiAccountsNotificationPusher[] =>
    latestOrUndefined(list)?.pushers ?? [];
  const unavailable = (): MessageKey | undefined => {
    switch (latestOrUndefined(list)?.web_push_unavailable_reason) {
      case "secret_not_configured":
        return "account.devices.unavailable.secret";
      case "relay_not_configured":
        return "account.devices.unavailable.relay";
      case "issuer_not_https":
        return "account.devices.unavailable.issuer";
      default:
        return undefined;
    }
  };

  return (
    <div class="acct-stack">
      <Card>
        <CardHeader
          title={
            <span class="wc-card-title-with-icon">
              <BellRing size={18} />
              {t("account.devices.title")}
            </span>
          }
          subtitle={t("account.devices.subtitle")}
        />
        <CardSection>
          <p class="acct-help">{t("account.devices.help")}</p>
          <Show when={unavailable()}>
            {(key) => <p class="acct-help">{t(key())}</p>}
          </Show>
        </CardSection>
        <Show when={error()}>
          {(message) => (
            <Toast tone="error">
              {t("account.devices.error", { message: message() })}
            </Toast>
          )}
        </Show>
      </Card>

      <section class="acct-list-section" aria-label={t("account.devices.listLabel")}>
        <h2 class="acct-list-title">{t("account.devices.listLabel")}</h2>
        <Switch>
          <Match when={list.error}>
            <Toast tone="error">
              <span class="wc-form-actions">
                <span>{fetchFailedMessage(list.error, t)}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  busy={list.loading}
                  onClick={() => void refetch()}
                >
                  {t("common.retry")}
                </Button>
              </span>
            </Toast>
          </Match>
          <Match when={list.loading && !list.latest}>
            <Skeleton variant="card" count={1} />
          </Match>
          <Match when={rows().length === 0}>
            <p class="muted">{t("account.devices.empty")}</p>
          </Match>
          <Match when>
            <ul class="acct-list">
              <For each={rows()}>
                {(pusher) => {
                  const health = () => notificationPusherHealth(pusher);
                  return (
                    <li class="acct-row tg-card" data-pusher-health={health()}>
                      <div class="acct-row-main">
                        <div class="acct-row-title">
                          <strong>{pusher.device_display_name}</strong>
                          <Badge
                            tone={health() === "failing" ? "danger" : health() === "ok" ? "ok" : "muted"}
                          >
                            {t(
                              health() === "failing"
                                ? "account.devices.failing"
                                : health() === "ok"
                                  ? "account.devices.working"
                                  : "account.devices.unused",
                            )}
                          </Badge>
                        </div>
                        <div class="acct-row-meta">
                          <span>{t("account.devices.added", { date: formatDate(pusher.created_at) })}</span>
                          <Show when={pusher.last_success_at}>
                            {(at) => (
                              <span>
                                {t("account.devices.lastDelivered")} <RelativeTime iso={at()} />
                              </span>
                            )}
                          </Show>
                          <Show when={pusher.failing && pusher.last_failure_at}>
                            {(at) => (
                              <span>
                                {t("account.devices.lastFailed")} <RelativeTime iso={at()} />
                              </span>
                            )}
                          </Show>
                        </div>
                        <Show when={pusher.failing}>
                          <p class="acct-help">{t("account.devices.failingHelp")}</p>
                        </Show>
                      </div>
                      <div class="acct-row-actions">
                        <Show
                          when={confirming() === pusher.id}
                          fallback={
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirming(pusher.id)}
                            >
                              {t("account.devices.remove")}
                            </Button>
                          }
                        >
                          <div class="acct-confirm" role="group">
                            <span>{t("account.devices.removeConsequence")}</span>
                            <Button
                              variant="danger"
                              size="sm"
                              busy={busy()}
                              onClick={() => void remove(pusher.id)}
                            >
                              {t("account.devices.removeConfirm")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirming(undefined)}
                            >
                              {t("common.cancel")}
                            </Button>
                          </div>
                        </Show>
                      </div>
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
