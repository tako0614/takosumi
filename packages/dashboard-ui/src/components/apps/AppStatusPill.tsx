interface Props {
  status?: string;
  class?: string;
}

// Aligned with the canonical contract enum
// (`TakosumiAppInstallationStatus`). Wave 6 removed the legacy
// `uninstalling` / `uninstalled` / `error` states; the canonical list is
// `installing` / `ready` / `failed` / `suspended` / `exported`.
const LABEL: Record<string, string> = {
  ready: "稼働中",
  installing: "インストール中",
  failed: "失敗",
  suspended: "停止中",
  exported: "エクスポート済み",
};

export default function AppStatusPill(props: Props) {
  const s = () => props.status ?? "unknown";
  return (
    <span class={`status-pill status-${s()} ${props.class ?? ""}`}>
      {LABEL[s()] ?? s()}
    </span>
  );
}
