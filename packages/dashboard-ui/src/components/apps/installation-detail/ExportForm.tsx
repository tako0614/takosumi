import { createSignal, Show } from "solid-js";
import { Download, HardDriveDownload } from "lucide-solid";
import { ApiError, type ExportOperation, rpc } from "~/lib/rpc";

const EXPORT_POLL_ATTEMPTS = 12;
const EXPORT_POLL_INTERVAL_MS = 1500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function ExportForm(props: { installationId: string }) {
  const [includeData, setIncludeData] = createSignal(false);
  const [encryptionMethod, setEncryptionMethod] = createSignal("none");
  const [recipients, setRecipients] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [operation, setOperation] = createSignal<ExportOperation | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const downloadHref = () => {
    const op = operation();
    if (!op || op.status !== "exported") return null;
    return (
      op.downloadUrl ??
      rpc.installations.exportDownloadUrl(props.installationId, op.operationId)
    );
  };

  const run = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setOperation(null);
    try {
      const recipientList = recipients()
        .split(/\r?\n|,/)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      let op = await rpc.installations.requestExport(props.installationId, {
        includeData: includeData(),
        encryptionMethod: encryptionMethod(),
        recipients: recipientList,
      });
      setOperation(op);
      // Poll the operation until it leaves the "preparing" state (or we give up).
      for (
        let attempt = 0;
        attempt < EXPORT_POLL_ATTEMPTS && op.status === "preparing";
        attempt++
      ) {
        await delay(EXPORT_POLL_INTERVAL_MS);
        op = await rpc.installations.getExportOperation(
          props.installationId,
          op.operationId,
        );
        setOperation(op);
      }
      if (op.status === "failed") {
        setErr(op.error ?? "export に失敗しました。");
      }
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="op-card">
      <h3>
        <HardDriveDownload size={16} /> Export
      </h3>
      <p class="muted">
        installation のエクスポートバンドルを作成します。完了するとダウンロード
        リンクが表示されます。
      </p>
      <form class="install-form" onSubmit={run}>
        <label class="op-checkbox">
          <input
            type="checkbox"
            checked={includeData()}
            onChange={(e) => setIncludeData(e.currentTarget.checked)}
          />
          データを含める (include data)
        </label>
        <label>
          Encryption
          <select
            value={encryptionMethod()}
            onChange={(e) => setEncryptionMethod(e.currentTarget.value)}
          >
            <option value="none">none</option>
            <option value="age">age</option>
          </select>
        </label>
        <Show when={encryptionMethod() !== "none"}>
          <label>
            Recipients (1 行に 1 つ / カンマ区切り)
            <textarea
              value={recipients()}
              onInput={(e) => setRecipients(e.currentTarget.value)}
              placeholder="age1..."
              rows={3}
            />
          </label>
        </Show>
        <button class="btn btn-secondary" type="submit" disabled={busy()}>
          <HardDriveDownload size={16} /> {busy() ? "Export 中..." : "Export"}
        </button>
      </form>
      <Show when={operation()}>
        {(op) => (
          <p class="muted" style="margin-top: 8px;">
            operation <code>{op().operationId}</code> — status:{" "}
            <strong>{op().status}</strong>
          </p>
        )}
      </Show>
      <Show when={downloadHref()}>
        {(href) => (
          <a class="btn btn-primary" href={href()} style="margin-top: 8px;">
            <Download size={16} /> ダウンロード
          </a>
        )}
      </Show>
      <Show when={err()}>{(m) => <p class="sign-in-error">{m()}</p>}</Show>
    </div>
  );
}
