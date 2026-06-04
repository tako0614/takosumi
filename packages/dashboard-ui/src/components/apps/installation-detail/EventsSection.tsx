import { createResource, For, Match, Show, Switch } from "solid-js";
import { rpc } from "~/lib/rpc";

function shortHash(hash: string | undefined): string {
  if (!hash) return "—";
  const body = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : hash;
  return body.length > 16 ? `${body.slice(0, 16)}…` : body;
}

export default function EventsSection(props: { installationId: string }) {
  const [events] = createResource(
    () => props.installationId,
    (id) => rpc.installations.events(id, { limit: 50 }),
  );
  return (
    <section class="detail-section">
      <h2>Events</h2>
      <Switch>
        <Match when={events.loading}>
          <div class="skel-block" />
        </Match>
        <Match when={events.error}>
          <p class="muted">イベントを取得できませんでした。</p>
        </Match>
        <Match when={events()}>
          {(result) => (
            <Show
              when={result().events.length > 0}
              fallback={<p class="muted">まだイベントはありません。</p>}
            >
              <p class="muted">
                hash chain:{" "}
                <strong>{result().hashChainValid ? "valid" : "invalid"}</strong>
              </p>
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Created</th>
                    <th>Event hash</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={result().events}>
                    {(event) => (
                      <tr>
                        <td>{event.type}</td>
                        <td>{event.createdAt ?? "—"}</td>
                        <td>
                          <code>{shortHash(event.eventHash)}</code>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          )}
        </Match>
      </Switch>
    </section>
  );
}
