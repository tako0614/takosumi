import { For } from "solid-js";
import Section from "./Section";

interface Stat {
  readonly num: string;
  readonly label: string;
  readonly note: string;
}

// Honest, verifiable facts only — no invented numbers (same rule as pricing.ts).
const STATS: readonly Stat[] = [
  { num: "¥0", label: "セルフホスト", note: "ソフトは無料。かかるのはインフラ費用だけ" },
  { num: "AGPL", label: "ライセンス", note: "すべて公開・フォーク自由" },
  {
    num: "1",
    label: "箇所に集約",
    note: "計画・適用・状態・出力をまとめて記録",
  },
  {
    num: "any",
    label: "OpenTofu provider",
    note: "任意の OpenTofu provider を接続",
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
