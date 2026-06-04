import { createSignal, Show } from "solid-js";
import { Server } from "lucide-solid";
import { type Installation, rpc } from "~/lib/rpc";
import { ActionError, createAction } from "~/lib/action";

export default function MaterializeForm(props: {
  installation: Installation;
  onDone: () => void;
}) {
  const [region, setRegion] = createSignal("default");
  const [costAck, setCostAck] = createSignal(false);

  const materialize = createAction(async () => {
    const updated = await rpc.installations.materialize(
      props.installation.installationId,
      { region: region(), costAck: costAck() },
    );
    props.onDone();
    return `materialize を受け付けました (status: ${updated.status ?? "?"})`;
  });
  const status = materialize.result;

  const run = (e: Event) => {
    e.preventDefault();
    materialize.clearResult();
    void materialize.run();
  };

  return (
    <div class="op-card">
      <h3>
        <Server size={16} /> Materialize (dedicated)
      </h3>
      <p class="muted">
        shared-cell の installation を専用セルへ昇格します。コストが発生するため
        確認が必要です。
      </p>
      <form class="install-form" onSubmit={run}>
        <label>
          Region
          <input
            type="text"
            value={region()}
            onInput={(e) => setRegion(e.currentTarget.value)}
            placeholder="default"
          />
        </label>
        <label class="op-checkbox">
          <input
            type="checkbox"
            checked={costAck()}
            onChange={(e) => setCostAck(e.currentTarget.checked)}
          />
          コスト発生を承認する (cost acknowledgement)
        </label>
        <button
          class="btn btn-primary"
          type="submit"
          disabled={materialize.busy() || !costAck()}
        >
          <Server size={16} />{" "}
          {materialize.busy() ? "Materialize 中..." : "Materialize"}
        </button>
      </form>
      <Show when={status()}>
        {(m) => (
          <p class="muted" style="margin-top: 8px;">
            {m()}
          </p>
        )}
      </Show>
      <ActionError error={materialize.error} />
    </div>
  );
}
