/**
 * Installations view (spec §31) — per-Space Installation list.
 *
 * For the current Space (space-state.ts), lists Installations via
 * `GET /api/v1/spaces/:id/installations` and the dependency DAG via
 * `GET /api/v1/spaces/:id/graph`, then renders each Installation with:
 *   - name / environment / status (with a `stale` badge),
 *   - depends-on (producer Installations from the graph edges), and
 *   - current generation + output-snapshot presence (MVP — the control routes
 *     do not yet expose projected output VALUES to the session surface, so we
 *     show the generation cursor + whether a snapshot exists rather than values).
 *
 * Each row links to the Plan summary flow via a "変更を確認" (plan) action that
 * creates a plan Run and navigates to the run view.
 */
import "../../styles/wave-a.css";
import { createMemo, createResource, For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Boxes } from "lucide-solid";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import SpaceSelector from "./SpaceSelector.tsx";
import { currentSpaceId } from "./space-state.ts";
import {
  type ActivityEvent,
  type ControlApiError,
  extractRunId,
  getDeployment,
  getSpaceGraph,
  type Installation,
  listActivity,
  listInstallations,
  planInstallation,
  type SpaceGraph,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import { controlInstallationStatusLabel } from "../../lib/status-labels.ts";
import { installationTone } from "./run-tone.ts";
import PageHeader from "../../components/ui/PageHeader.tsx";
import Button from "../../components/ui/Button.tsx";
import DataTable, { type Column } from "../../components/ui/DataTable.tsx";
import { Badge, StatusBadge } from "../../components/ui/Badge.tsx";
import EmptyState from "../../components/ui/EmptyState.tsx";

export default function ControlInstallationsView() {
  return <Page title="Installations">{() => <Inner />}</Page>;
}

function Inner() {
  const navigate = useNavigate();
  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);

  const [installations] = createResource(spaceId, listInstallations);
  const [graph] = createResource(spaceId, getSpaceGraph);
  const [activity] = createResource(spaceId, (id) => listActivity(id, 100));

  // Build: consumerInstallationId -> [producer node names], from the graph edges.
  const dependsOn = createMemo(() => {
    const g: SpaceGraph | undefined = graph();
    const map = new Map<string, string[]>();
    if (!g) return map;
    const nameById = new Map(g.nodes.map((n) => [n.installationId, n.name]));
    for (const edge of g.edges) {
      const producerName =
        nameById.get(edge.producerInstallationId) ??
        edge.producerInstallationId;
      const list = map.get(edge.consumerInstallationId) ?? [];
      list.push(producerName);
      map.set(edge.consumerInstallationId, list);
    }
    return map;
  });
  const staleReasons = createMemo(() => {
    const map = new Map<string, string>();
    for (const event of activity() ?? []) {
      if (
        event.action !== "installation.stale" ||
        event.targetType !== "installation" ||
        map.has(event.targetId)
      ) {
        continue;
      }
      const reason = staleReasonFromActivity(event);
      if (reason) map.set(event.targetId, reason);
    }
    return map;
  });

  // Resolve a per-Installation launch URL from its current Deployment's public
  // outputs (the same allowlist-projected `outputsPublic` the detail view's 出力
  // section surfaces). Fetched here so a row can offer a direct "開く" link
  // without a detour through 詳細. Installations without a current deployment or
  // a URL-shaped public output simply get no link.
  const [launchUrls] = createResource(installations, async (list) => {
    const map = new Map<string, string>();
    await Promise.all(
      list
        .filter((inst): inst is Installation & { currentDeploymentId: string } =>
          Boolean(inst.currentDeploymentId)
        )
        .map(async (inst) => {
          try {
            const deployment = await getDeployment(inst.currentDeploymentId);
            const url = launchUrlFromOutputs(deployment.outputsPublic);
            if (url) map.set(inst.id, url);
          } catch {
            // A single deployment read failing must not blank the whole list;
            // the row just falls back to no launch link.
          }
        }),
    );
    return map;
  });

  const plan = createAction(async (installationId: string) => {
    const envelope = await planInstallation(installationId);
    const runId = extractRunId(envelope);
    if (runId) navigate(`/runs/${runId}`);
  });

  const columns: readonly Column<Installation>[] = [
    {
      header: "名前",
      cell: (inst) => (
        <div>
          <div class="installation-name">{inst.name}</div>
          <code class="wa-id">{inst.id}</code>
        </div>
      ),
    },
    {
      header: "状態",
      cell: (inst) => (
        <div>
          <StatusBadge
            status={inst.status}
            label={controlInstallationStatusLabel}
            tone={installationTone}
          />
          <Show
            when={inst.status === "stale" && staleReasons().get(inst.id)}
          >
            {(reason) => (
              <div class="muted installation-stale-reason">
                Reason: {reason()}
              </div>
            )}
          </Show>
        </div>
      ),
    },
    {
      header: "依存",
      cell: (inst) => (
        <Show
          when={(dependsOn().get(inst.id) ?? []).length > 0}
          fallback={<span class="muted">—</span>}
        >
          <ul class="wa-dep-list">
            <For each={dependsOn().get(inst.id) ?? []}>
              {(name) => (
                <li>
                  <code>{name}</code>
                </li>
              )}
            </For>
          </ul>
        </Show>
      ),
    },
    {
      header: "世代 / 出力",
      cell: (inst) => (
        <span>
          <span class="muted">gen</span> {inst.currentStateGeneration}
          <Show when={inst.currentOutputSnapshotId}>
            {" "}
            <Badge tone="info">outputs</Badge>
          </Show>
        </span>
      ),
    },
    {
      header: "",
      align: "right",
      cell: (inst) => (
        <div class="wa-row-actions">
          <Show when={launchUrls()?.get(inst.id)}>
            {(url) => (
              <Button
                variant="primary"
                size="sm"
                href={url()}
                target="_blank"
                rel="noreferrer noopener"
              >
                開く
              </Button>
            )}
          </Show>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={plan.busy()}
            onClick={() => void plan.run(inst.id)}
          >
            変更を確認
          </Button>
          <Button
            variant="ghost"
            size="sm"
            href={`/installations/${encodeURIComponent(inst.id)}`}
          >
            詳細
          </Button>
        </div>
      ),
    },
  ];

  return (
    <AppShell>
      <PageHeader
        eyebrow="Installations"
        title="Installations"
        subtitle="Space 配下の Capsule Installation を確認します。"
        actions={
          <div class="wa-actions">
            <Button variant="primary" href="/install">
              + Git から導入
            </Button>
            <Button variant="secondary" href="/graph">
              依存グラフ
            </Button>
          </div>
        }
      />

      <SpaceSelector />

      <Show
        when={spaceId()}
        fallback={
          <EmptyState
            ink
            icon={<Boxes size={28} />}
            title="Space を選択してください"
            message="Space を選択すると Installation 一覧を表示します。"
          />
        }
      >
        <Show when={plan.error()}>
          {(m) => <p class="wa-error">{m()}</p>}
        </Show>
        <DataTable
          columns={columns}
          rows={installations()}
          rowKey={(inst) => inst.id}
          loading={installations.loading}
          skeletonRows={3}
          error={
            installations.error
              ? `取得に失敗しました — ${(installations.error as ControlApiError).message}`
              : undefined
          }
          empty={
            <EmptyState
              ink
              icon={<Boxes size={28} />}
              title="まだ Installation がありません"
              message="この Space にはまだ Installation がありません。"
              action={
                <Button variant="primary" href="/install">
                  最初の Installation を導入 →
                </Button>
              }
            />
          }
        />
      </Show>
    </AppShell>
  );
}

/**
 * Pick a launch URL from a Deployment's public outputs. Prefers the well-known
 * `launch_url` / `url` / `app_url` keys (the detail view's primary "目立たせ"
 * outputs); otherwise falls back to the first http(s)-shaped value.
 */
function launchUrlFromOutputs(
  outputs: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const key of ["launch_url", "url", "app_url", "public_url"]) {
    const value = outputs[key];
    if (isUrlString(value)) return value;
  }
  for (const value of Object.values(outputs)) {
    if (isUrlString(value)) return value;
  }
  return undefined;
}

/** True for a string value that looks like an http(s) address worth linking. */
function isUrlString(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function staleReasonFromActivity(event: ActivityEvent): string | undefined {
  const reasons = event.metadata.reasons;
  if (Array.isArray(reasons)) {
    const text = reasons
      .filter((entry): entry is string => typeof entry === "string")
      .join(", ");
    if (text) return text;
  }
  const changed = event.metadata.changedOutputs;
  const producer = event.metadata.producerInstallationName;
  if (Array.isArray(changed) && typeof producer === "string") {
    const text = changed
      .filter((entry): entry is string => typeof entry === "string")
      .map((name) => `${producer}.${name} changed`)
      .join(", ");
    if (text) return text;
  }
  return undefined;
}
