/**
 * `DirectCloudflareWorkersLifecycle` — drives Cloudflare Workers via the REST
 * API.
 *
 * Endpoint: /accounts/{accountId}/workers/scripts/{scriptName}
 *
 * Workers script upload uses multipart/form-data with two parts:
 *   - `metadata` (application/json): { main_module, compatibility_date,
 *     compatibility_flags?, bindings? }
 *   - `<mainModule>` (application/javascript+module): the bundle bytes
 *
 * `publicUrl` resolves the operator-specific `*.workers.dev` subdomain via
 * `GET /accounts/{id}/workers/subdomain`. The fetched subdomain is cached
 * for the lifetime of the lifecycle instance. If the operator has not
 * configured a subdomain (404 response or empty string), we fall back to
 * `${accountId}.workers.dev` so deploys still produce a deterministic URL,
 * and emit a `console.warn` instructing the operator to configure one.
 */

const BASE_URL = "https://api.cloudflare.com/client/v4";
const METADATA_CONTENT_TYPE = "application/json";
const MODULE_CONTENT_TYPE = "application/javascript+module";

export interface CloudflareWorkersCreateInput {
  readonly scriptName: string;
  readonly bundle: Uint8Array;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly mainModule: string;
}

export interface CloudflareWorkersDescriptor {
  readonly accountId: string;
  readonly scriptName: string;
  readonly publicUrl: string;
}

export interface CloudflareWorkersLifecycleClient {
  putScript(
    input: CloudflareWorkersCreateInput,
  ): Promise<CloudflareWorkersDescriptor>;
  deleteScript(input: { readonly scriptName: string }): Promise<boolean>;
  describeScript(
    input: { readonly scriptName: string },
  ): Promise<CloudflareWorkersDescriptor | undefined>;
}

export interface DirectCloudflareWorkersLifecycleOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

interface CloudflareEnvelope {
  readonly success?: boolean;
  readonly errors?: readonly { code: number; message: string }[];
}

interface CloudflareSubdomainEnvelope extends CloudflareEnvelope {
  readonly result?: { readonly subdomain?: string };
}

export class DirectCloudflareWorkersLifecycle
  implements CloudflareWorkersLifecycleClient {
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;
  /**
   * Memoised subdomain promise. Resolves to the operator's account-specific
   * `*.workers.dev` subdomain, or `undefined` when none is configured (in
   * which case `#publicUrlFor` falls back to the bare account id).
   */
  #subdomainPromise: Promise<string | undefined> | undefined;
  #subdomainWarned = false;

  constructor(options: DirectCloudflareWorkersLifecycleOptions) {
    this.#accountId = options.accountId;
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * Fetch — and cache — the account-specific `*.workers.dev` subdomain.
   * Returns `undefined` when the operator has not configured one (404 from
   * the API, missing field, or empty string). Subsequent calls return the
   * cached value without hitting the API again.
   */
  fetchSubdomain(): Promise<{ readonly subdomain: string | undefined }> {
    if (!this.#subdomainPromise) {
      this.#subdomainPromise = this.#fetchSubdomainOnce();
    }
    return this.#subdomainPromise.then((subdomain) => ({ subdomain }));
  }

  async putScript(
    input: CloudflareWorkersCreateInput,
  ): Promise<CloudflareWorkersDescriptor> {
    const subdomain = await this.#resolveSubdomain();
    const url = this.#scriptUrl(input.scriptName);
    const body = buildScriptForm(input);
    const response = await this.#fetch(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${this.#apiToken}` },
      body,
    });
    await ensureOk(response, `cf-workers:PutScript ${input.scriptName}`);
    return {
      accountId: this.#accountId,
      scriptName: input.scriptName,
      publicUrl: this.#publicUrlFor(input.scriptName, subdomain),
    };
  }

  async deleteScript(
    input: { readonly scriptName: string },
  ): Promise<boolean> {
    const url = this.#scriptUrl(input.scriptName);
    const response = await this.#fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.#apiToken}` },
    });
    if (response.status === 404) return false;
    await ensureOk(response, `cf-workers:DeleteScript ${input.scriptName}`);
    return true;
  }

  async describeScript(
    input: { readonly scriptName: string },
  ): Promise<CloudflareWorkersDescriptor | undefined> {
    const url = this.#scriptUrl(input.scriptName);
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#apiToken}` },
    });
    if (response.status === 404) return undefined;
    await ensureOk(response, `cf-workers:GetScript ${input.scriptName}`);
    const subdomain = await this.#resolveSubdomain();
    return {
      accountId: this.#accountId,
      scriptName: input.scriptName,
      publicUrl: this.#publicUrlFor(input.scriptName, subdomain),
    };
  }

  /**
   * Verify-only: GET `/accounts/{id}/workers/subdomain`. 200 / 404 both mean
   * the credentials are valid; non-2xx / non-404 are treated as errors. Used
   * by `CloudflareWorkersConnector.verify`.
   */
  async fetchSubdomainResponse(): Promise<Response> {
    const url = `${BASE_URL}/accounts/${this.#accountId}/workers/subdomain`;
    return await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#apiToken}` },
    });
  }

  async #fetchSubdomainOnce(): Promise<string | undefined> {
    const url = `${BASE_URL}/accounts/${this.#accountId}/workers/subdomain`;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#apiToken}` },
    });
    if (response.status === 404) return undefined;
    await ensureOk(response, `cf-workers:GetSubdomain ${this.#accountId}`);
    try {
      const body = await response.json() as CloudflareSubdomainEnvelope;
      const sub = body.result?.subdomain;
      if (typeof sub === "string" && sub.length > 0) return sub;
      return undefined;
    } catch {
      return undefined;
    }
  }

  async #resolveSubdomain(): Promise<string | undefined> {
    const sub = await this.fetchSubdomain();
    if (sub.subdomain === undefined && !this.#subdomainWarned) {
      this.#subdomainWarned = true;
      console.warn(
        `[cf-workers] account ${this.#accountId} has no *.workers.dev subdomain ` +
          "configured — falling back to https://<script>.<accountId>.workers.dev. " +
          "Configure one in the Cloudflare dashboard (Workers > Subdomain) to publish the canonical URL.",
      );
    }
    return sub.subdomain;
  }

  #scriptUrl(scriptName: string): string {
    return `${BASE_URL}/accounts/${this.#accountId}/workers/scripts/${scriptName}`;
  }

  #publicUrlFor(scriptName: string, subdomain: string | undefined): string {
    const host = subdomain ?? this.#accountId;
    return `https://${scriptName}.${host}.workers.dev`;
  }
}

/**
 * Build the multipart/form-data body for a Workers script upload. The first
 * part is the JSON metadata declaring `main_module`, compatibility settings,
 * and optional plain-text bindings derived from `env`. The second part is the
 * JS bundle blob registered under the same module name as `main_module`.
 */
function buildScriptForm(input: CloudflareWorkersCreateInput): FormData {
  const metadata: Record<string, unknown> = {
    main_module: input.mainModule,
    compatibility_date: input.compatibilityDate,
  };
  if (input.compatibilityFlags && input.compatibilityFlags.length > 0) {
    metadata.compatibility_flags = [...input.compatibilityFlags];
  }
  const bindings = envBindings(input.env);
  if (bindings.length > 0) metadata.bindings = bindings;
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: METADATA_CONTENT_TYPE }),
    "metadata.json",
  );
  // Wrap the bundle in a Blob with the module content-type so Cloudflare
  // recognises it as an ES module entrypoint. Copy through a fresh ArrayBuffer
  // so the BlobPart typing doesn't reject SharedArrayBuffer-backed inputs.
  const buffer = new ArrayBuffer(input.bundle.byteLength);
  new Uint8Array(buffer).set(input.bundle);
  const blob = new Blob([buffer], { type: MODULE_CONTENT_TYPE });
  form.append(input.mainModule, blob, input.mainModule);
  return form;
}

function envBindings(
  env: Readonly<Record<string, string>> | undefined,
): {
  readonly type: "plain_text";
  readonly name: string;
  readonly text: string;
}[] {
  if (!env) return [];
  return Object.entries(env).map(([name, text]) => ({
    type: "plain_text" as const,
    name,
    text,
  }));
}

async function ensureOk(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const env = JSON.parse(text) as CloudflareEnvelope;
        if (env.errors && env.errors.length > 0) {
          detail = env.errors.map((e) => `${e.code}:${e.message}`).join(", ");
        } else {
          detail = text;
        }
      } catch {
        detail = text;
      }
    }
  } catch {
    // ignore body read failures
  }
  throw new Error(
    `${context} failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
  );
}
