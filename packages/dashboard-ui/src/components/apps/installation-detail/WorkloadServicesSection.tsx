import { createSignal, For, Match, Show, Switch } from "solid-js";
import { KeyRound, RotateCw } from "lucide-solid";
import {
  ApiError,
  type RotateWorkloadServiceTokenResult,
  type WorkloadService,
  rpc,
} from "~/lib/rpc";
import OutputValue from "~/components/apps/installation-detail/OutputValue";

export default function WorkloadServicesSection(props: {
  installationId: string;
  services: readonly WorkloadService[] | undefined;
  loading: boolean;
  error: unknown;
  onRotated: () => void;
}) {
  const [busyService, setBusyService] = createSignal<string | null>(null);
  const [rotation, setRotation] =
    createSignal<RotateWorkloadServiceTokenResult | null>(null);
  const [err, setErr] = createSignal<string | null>(null);

  const rotate = async (service: WorkloadService) => {
    setBusyService(service.id);
    setErr(null);
    setRotation(null);
    try {
      const result = await rpc.installations.rotateServiceToken(
        props.installationId,
        service.id,
      );
      setRotation(result);
      props.onRotated();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusyService(null);
    }
  };

  return (
    <section class="detail-section">
      <h2>Services</h2>
      <Switch>
        <Match when={props.loading}>
          <div class="skel-block" />
        </Match>
        <Match when={props.error}>
          <p class="muted">サービスを取得できませんでした。</p>
        </Match>
        <Match when={props.services}>
          {(services) => (
            <Show
              when={services().length > 0}
              fallback={<p class="muted">—</p>}
            >
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Status</th>
                    <th>Endpoint</th>
                    <th>Secret</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <For each={services()}>
                    {(service) => (
                      <tr>
                        <td>
                          <code>{service.id}</code>
                          <div class="muted">{service.materialKind}</div>
                        </td>
                        <td>{service.status}</td>
                        <td>
                          <Show when={service.endpoint} fallback={<>—</>}>
                            {(endpoint) => <OutputValue value={endpoint()} />}
                          </Show>
                        </td>
                        <td>
                          <Show when={service.secretRef} fallback={<>—</>}>
                            {(secretRef) => (
                              <>
                                <code>{secretRef()}</code>
                                <Show when={service.tokenExpiresAt}>
                                  {(expiresAt) => (
                                    <div class="muted">
                                      expires {expiresAt()}
                                    </div>
                                  )}
                                </Show>
                              </>
                            )}
                          </Show>
                        </td>
                        <td>
                          <Show when={service.rotateTokenUrl}>
                            <button
                              class="btn btn-secondary"
                              type="button"
                              disabled={busyService() === service.id}
                              onClick={() => void rotate(service)}
                            >
                              <RotateCw size={16} />{" "}
                              {busyService() === service.id
                                ? "Rotating"
                                : "Rotate"}
                            </button>
                          </Show>
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
      <Show when={rotation()}>
        {(result) => (
          <div class="op-card" style="margin-top: 16px;">
            <h3>
              <KeyRound size={16} /> {result().service.id}
            </h3>
            <dl class="kv-list">
              <dt>Token</dt>
              <dd>
                <textarea
                  readOnly
                  rows={3}
                  value={result().token}
                  style="width: 100%;"
                />
              </dd>
              <dt>Secret ref</dt>
              <dd>
                <code>{result().service.secretRef ?? "—"}</code>
              </dd>
              <dt>Expires</dt>
              <dd>{result().expiresAt}</dd>
            </dl>
          </div>
        )}
      </Show>
      <Show when={err()}>{(m) => <p class="sign-in-error">{m()}</p>}</Show>
    </section>
  );
}
