import "../../styles/wave-d.css";
import { useNavigate, useParams } from "@solidjs/router";
import { createResource, createSignal, Match, Switch } from "solid-js";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import AppDetailNav from "../account/components/AppDetailNav.tsx";
import { ApiError, rpc } from "../account/lib/api.ts";
import { ActionError, createAction } from "../account/lib/action.tsx";
import { Icons } from "../../lib/Icons.tsx";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import {
  Button,
  Card,
  CardHeader,
  CardSection,
  FormField,
  Input,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.ts";

export default function InstallationDangerView() {
  return <Page>{() => <Inner />}</Page>;
}

function Inner() {
  const params = useParams<{ id: string }>();
  const nav = useNavigate();
  const { confirm } = useConfirmDialog();
  const [app] = createResource(() => params.id, rpc.installations.get);
  const [typed, setTyped] = createSignal("");

  const uninstall = createAction(async (installationId: string) => {
    await rpc.installations.uninstall(installationId);
    nav("/apps");
  });

  const run = async () => {
    const a = app();
    if (!a) return;
    if (typed() !== a.appId) {
      uninstall.setError(`appId (${a.appId}) を正確に入力してください。`);
      return;
    }
    const ok = await confirm({
      title: "アプリを削除",
      message:
        `本当に ${a.installationId} を削除しますか？ この操作は取り消せません。`,
      confirmText: "削除",
      danger: true,
    });
    if (!ok) return;
    void uninstall.run(a.installationId);
  };

  return (
    <AppShell>
      <Switch>
        <Match when={app.loading}>
          <Skeleton variant="block" style="height: 200px;" />
        </Match>
        <Match when={app.error}>
          <PageHeader title="取得に失敗しました" />
          <p>{(app.error as ApiError).message}</p>
        </Match>
        <Match when={app()}>
          {(a) => (
            <>
              <PageHeader
                eyebrow="Danger zone"
                title={a().appId}
                subtitle={
                  <>
                    installation id:{" "}
                    <code class="wave-d-mono">{a().installationId}</code>
                  </>
                }
              />
              <AppDetailNav installationId={a().installationId} />

              <div class="wave-d-stack">
                <Card class="tg-card-danger">
                  <CardHeader
                    title={
                      <span style="display:inline-flex;align-items:center;gap:8px">
                        <Icons.AlertTriangle class="wave-d-ico" /> アプリを削除
                      </span>
                    }
                    subtitle="このアプリを完全に削除します。 取り消せません。"
                  />
                  <CardSection>
                    <p class="tg-card-subtitle">
                      続行するには appId (
                      <code class="wave-d-mono">{a().appId}</code>)
                      を正確に入力してください。
                    </p>
                    <FormField label="appId を入力して確認">
                      <Input
                        type="text"
                        value={typed()}
                        onInput={(e) => setTyped(e.currentTarget.value)}
                        placeholder={a().appId}
                        autocomplete="off"
                        invalid={!!typed() && typed() !== a().appId}
                      />
                    </FormField>
                    <div class="wave-d-actions">
                      <Button
                        variant="danger"
                        type="button"
                        onClick={() => void run()}
                        busy={uninstall.busy()}
                        disabled={uninstall.busy() || typed() !== a().appId}
                        icon={<Icons.Trash class="wave-d-ico" />}
                      >
                        {uninstall.busy() ? "削除中..." : "削除"}
                      </Button>
                    </div>
                    <ActionError error={uninstall.error} />
                  </CardSection>
                </Card>
              </div>
            </>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}
