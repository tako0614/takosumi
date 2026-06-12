import "../../../styles/wave-d.css";
import { A } from "@solidjs/router";
import { Box, GitBranch, Server } from "lucide-solid";
import type { Installation } from "../lib/api.ts";
import { Card, StatusBadge } from "../../../components/ui/index.ts";
import { installationStatusLabel } from "../../../lib/status-labels.ts";
import { installationStatusTone } from "./AppStatusPill.tsx";

/** Ported from takosumi dashboard-ui/src/components/apps/AppCard.tsx. */
export default function AppCard(props: { app: Installation }) {
  const ref = () => props.app.sourceRef ?? "main";
  const repoLabel = () => {
    const url = props.app.sourceGitUrl;
    if (!url) return props.app.appId;
    try {
      const u = new URL(url);
      return u.pathname.replace(/^\/+|\.git$/g, "");
    } catch {
      return url;
    }
  };
  return (
    <Card hover>
      <A
        href={`/apps/${encodeURIComponent(props.app.installationId)}`}
        class="wave-d-app-card"
      >
        <div class="wave-d-app-card-head">
          <Box size={18} />
          <span class="wave-d-app-card-name">{props.app.appId}</span>
          <StatusBadge
            status={props.app.status}
            label={installationStatusLabel}
            tone={installationStatusTone}
          />
        </div>
        <div class="wave-d-app-card-meta">
          <span class="wave-d-app-card-meta-item">
            <GitBranch size={13} /> {repoLabel()} @ {ref()}
          </span>
          <span class="wave-d-app-card-meta-item">
            <Server size={13} /> {props.app.mode ?? "—"}
          </span>
        </div>
      </A>
    </Card>
  );
}
