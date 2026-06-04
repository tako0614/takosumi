import { For, Show } from "solid-js";
import { type OidcClientConfig } from "~/lib/rpc";

export default function OidcClientSection(props: {
  client: OidcClientConfig | undefined;
}) {
  return (
    <section class="detail-section">
      <h2>OIDC Client</h2>
      <Show
        when={props.client}
        fallback={
          <p class="muted">この installation には OIDC client がありません。</p>
        }
      >
        {(client) => (
          <dl class="kv-list">
            <dt>Client ID</dt>
            <dd>
              <code>{client().clientId}</code>
            </dd>
            <dt>Issuer</dt>
            <dd>
              <code>{client().issuerUrl ?? "—"}</code>
            </dd>
            <dt>Service path</dt>
            <dd>
              <code>{client().servicePath ?? "—"}</code>
            </dd>
            <dt>Redirect URIs</dt>
            <dd>
              <Show
                when={(client().redirectUris ?? []).length > 0}
                fallback={<>—</>}
              >
                <For each={client().redirectUris ?? []}>
                  {(uri) => (
                    <div>
                      <code>{uri}</code>
                    </div>
                  )}
                </For>
              </Show>
            </dd>
            <dt>Allowed scopes</dt>
            <dd>{(client().allowedScopes ?? []).join(", ") || "—"}</dd>
            <dt>Subject mode</dt>
            <dd>{client().subjectMode ?? "—"}</dd>
            <dt>Token endpoint auth</dt>
            <dd>{client().tokenEndpointAuthMethod ?? "—"}</dd>
          </dl>
        )}
      </Show>
    </section>
  );
}
