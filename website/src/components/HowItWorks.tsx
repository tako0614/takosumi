export default function HowItWorks() {
  return (
    <section id="how">
      <div class="container">
        <span class="eyebrow">How it works</span>
        <h2>Manifest → Kernel → Runtime-agent → Substrate。</h2>
        <p class="lede">
          control plane (kernel) は manifest を DAG に解いて apply 計画を立て、
          data plane (runtime-agent) が credential 付きで substrate を叩く。
        </p>

        <div class="howflow">
          <svg viewBox="0 0 480 320" xmlns="http://www.w3.org/2000/svg" aria-label="Apply pipeline diagram">
            <defs>
              <linearGradient id="flowg" x1="0" y1="0" x2="480" y2="320" gradientUnits="userSpaceOnUse">
                <stop offset="0" stop-color="var(--tg-grad-from)" />
                <stop offset="1" stop-color="var(--tg-grad-to)" />
              </linearGradient>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M0 0 L10 5 L0 10 z" fill="var(--tg-fg-muted)" />
              </marker>
            </defs>

            {/* manifest */}
            <g transform="translate(20,20)">
              <rect width="120" height="60" rx="10" fill="var(--tg-bg-elev)" stroke="var(--tg-line-strong)" />
              <text x="60" y="28" text-anchor="middle" fill="var(--tg-fg)" font-family="var(--tg-font-mono)" font-size="13" font-weight="600">manifest.yml</text>
              <text x="60" y="46" text-anchor="middle" fill="var(--tg-fg-muted)" font-size="11">resources[]</text>
            </g>

            {/* kernel */}
            <g transform="translate(180,20)">
              <rect width="140" height="60" rx="10" fill="url(#flowg)" />
              <text x="70" y="28" text-anchor="middle" fill="#fff" font-weight="700" font-size="13">kernel</text>
              <text x="70" y="46" text-anchor="middle" fill="rgba(255,255,255,0.85)" font-size="11">apply pipeline · DAG</text>
            </g>

            {/* runtime-agent */}
            <g transform="translate(180,130)">
              <rect width="140" height="60" rx="10" fill="var(--tg-bg-elev)" stroke="var(--tg-accent)" stroke-width="1.5" />
              <text x="70" y="28" text-anchor="middle" fill="var(--tg-fg)" font-weight="700" font-size="13">runtime-agent</text>
              <text x="70" y="46" text-anchor="middle" fill="var(--tg-fg-muted)" font-size="11">SigV4 · OAuth · kubectl · docker</text>
            </g>

            {/* substrates */}
            <g font-family="var(--tg-font-mono)" font-size="11" fill="var(--tg-fg)">
              {[
                { x: 20, y: 240, label: "AWS" },
                { x: 110, y: 240, label: "GCP" },
                { x: 200, y: 240, label: "Cloudflare" },
                { x: 310, y: 240, label: "Azure" },
                { x: 380, y: 240, label: "K8s" },
                { x: 20, y: 280, label: "docker" },
                { x: 110, y: 280, label: "systemd" },
                { x: 200, y: 280, label: "filesystem" },
                { x: 310, y: 280, label: "bare-metal" },
              ].map((s) => (
                <g transform={`translate(${s.x},${s.y})`}>
                  <rect width="84" height="28" rx="8" fill="var(--tg-bg-subtle)" stroke="var(--tg-line)" />
                  <text x="42" y="18" text-anchor="middle">{s.label}</text>
                </g>
              ))}
            </g>

            {/* arrows */}
            <path d="M140 50 L 180 50" stroke="var(--tg-fg-muted)" stroke-width="1.5" marker-end="url(#arr)" />
            <path d="M250 80 L 250 130" stroke="var(--tg-fg-muted)" stroke-width="1.5" marker-end="url(#arr)" />
            <path d="M250 190 L 250 220" stroke="var(--tg-fg-muted)" stroke-width="1.5" marker-end="url(#arr)" />
          </svg>

          <ol>
            <li>
              <strong>Manifest を書く</strong>
              <span>resources[].shape + provider + spec を YAML で。 project convention 自動探索なし。</span>
            </li>
            <li>
              <strong>kernel が plan</strong>
              <span>DAG 解決 + idempotency key + dry-run preview。 credential には触らない。</span>
            </li>
            <li>
              <strong>runtime-agent が apply</strong>
              <span>credential を持つ data plane が cloud SDK / kubectl / docker を実行。</span>
            </li>
            <li>
              <strong>journal に永続化</strong>
              <span>operation journal で再開可能。 失敗時は自動 rollback。</span>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}
