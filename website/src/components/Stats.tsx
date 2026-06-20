import { For } from "solid-js";
import Section from "./Section";

interface Stat {
  readonly num: string;
  readonly label: string;
  readonly note: string;
}

// Honest, verifiable facts only — no invented numbers (same rule as pricing.ts).
const STATS: readonly Stat[] = [
  { num: "¥0", label: "セルフホスト", note: "ソフトは無料。基盤費だけ" },
  { num: "AGPL", label: "ライセンス", note: "全部公開・フォーク自由" },
  {
    num: "1",
    label: "箇所に集約",
    note: "計画・適用・状態・出力をまとめて記録",
  },
  {
    num: "5+",
    label: "実行先",
    note: "Cloudflare・AWS・GCP・K8s・VM…",
  },
];

export default function Stats() {
  return (
    <Section class="stats" title="預けるのではなく、持つ。">
      <div class="stats-grid">
        <For each={STATS}>
          {(s) => (
            <div class="stat">
              <div class="stat-num">{s.num}</div>
              <div class="stat-label">{s.label}</div>
              <p class="stat-note">{s.note}</p>
            </div>
          )}
        </For>
      </div>
    </Section>
  );
}
