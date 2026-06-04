import { Title } from "@solidjs/meta";
import { useNavigate, useParams } from "@solidjs/router";
import { AlertTriangle, Trash2 } from "lucide-solid";
import { createResource, createSignal, Match, Switch } from "solid-js";
import AppShell from "~/components/shell/AppShell";
import Page from "~/components/auth/Page";
import AppDetailNav from "~/components/apps/AppDetailNav";
import { ApiError, rpc } from "~/lib/rpc";
import { ActionError, createAction } from "~/lib/action";

export default function Danger() {
  return <Page>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams<{ id: string }>();
  const nav = useNavigate();
  const [app] = createResource(() => params.id, rpc.installations.get);
  const [typed, setTyped] = createSignal("");

  const uninstall = createAction(async (installationId: string) => {
    await rpc.installations.uninstall(installationId);
    nav("/apps");
  });

  const run = () => {
    const a = app();
    if (!a) return;
    if (typed() !== a.appId) {
      uninstall.setError(`appId (${a.appId}) を正確に入力してください。`);
      return;
    }
    if (
      !confirm(
        `本当に ${a.installationId} を uninstall しますか？ この操作は取り消せません。`,
      )
    ) {
      return;
    }
    void uninstall.run(a.installationId);
  };

  return (
    <AppShell>
      <Switch>
        <Match when={app.loading}>
          <div class="skel-block tall" />
        </Match>
        <Match when={app.error}>
          <Title>Danger zone — Takosumi</Title>
          <div class="page-header">
            <h1>取得に失敗しました</h1>
          </div>
          <p>{(app.error as ApiError).message}</p>
        </Match>
        <Match when={app()}>
          {(a) => (
            <>
              <Title>{a().appId} — Danger zone</Title>
              <div class="page-header">
                <h1>
                  {a().appId} <span class="page-sub-tag">danger zone</span>
                </h1>
                <p class="page-sub">
                  installation id: <code>{a().installationId}</code>
                </p>
              </div>
              <AppDetailNav installationId={a().installationId} />

              <section class="detail-section danger-zone">
                <h2>
                  <AlertTriangle size={18} /> Uninstall
                </h2>
                <p class="muted">
                  この installation を完全に削除します。 取り消せません。
                </p>
                <p class="muted">
                  続行するには appId (<code>{a().appId}</code>)
                  を正確に入力してください。
                </p>
                <div class="danger-form">
                  <input
                    type="text"
                    value={typed()}
                    onInput={(e) => setTyped(e.currentTarget.value)}
                    placeholder={a().appId}
                    autocomplete="off"
                  />
                  <button
                    class="btn btn-danger"
                    type="button"
                    onClick={run}
                    disabled={uninstall.busy() || typed() !== a().appId}
                  >
                    <Trash2 size={16} />{" "}
                    {uninstall.busy() ? "Uninstall 中..." : "Uninstall"}
                  </button>
                </div>
                <ActionError error={uninstall.error} />
              </section>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}
