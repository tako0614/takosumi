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
 * For v0 we construct `publicUrl` as
 * `https://${scriptName}.${accountId}.workers.dev` — Cloudflare's actual
 * subdomain is account-specific and could be resolved via
 * GET `/accounts/{id}/workers/subdomain`. Refining that is tracked separately.
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

export class DirectCloudflareWorkersLifecycle
  implements CloudflareWorkersLifecycleClient {
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: DirectCloudflareWorkersLifecycleOptions) {
    this.#accountId = options.accountId;
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async putScript(
    input: CloudflareWorkersCreateInput,
  ): Promise<CloudflareWorkersDescriptor> {
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
      publicUrl: this.#publicUrlFor(input.scriptName),
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
    return {
      accountId: this.#accountId,
      scriptName: input.scriptName,
      publicUrl: this.#publicUrlFor(input.scriptName),
    };
  }

  #scriptUrl(scriptName: string): string {
    return `${BASE_URL}/accounts/${this.#accountId}/workers/scripts/${scriptName}`;
  }

  #publicUrlFor(scriptName: string): string {
    return `https://${scriptName}.${this.#accountId}.workers.dev`;
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
  // recognises it as an ES module entrypoint.
  const blob = new Blob([input.bundle], { type: MODULE_CONTENT_TYPE });
  form.append(input.mainModule, blob, input.mainModule);
  return form;
}

function envBindings(
  env: Readonly<Record<string, string>> | undefined,
): { readonly type: "plain_text"; readonly name: string; readonly text: string }[] {
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
