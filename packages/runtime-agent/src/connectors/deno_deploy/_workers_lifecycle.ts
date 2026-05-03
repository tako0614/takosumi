/**
 * `DirectDenoDeployWorkersLifecycle` — drives Deno Deploy via its v1 REST API.
 *
 * Endpoint base: https://api.deno.com/v1
 *
 * The Deno Deploy API surface is multi-step:
 *   - `POST /organizations/{orgId}/projects` to create / look up a project for
 *     a script name (one project per resource).
 *   - `POST /projects/{projectId}/deployments` (multipart) to upload the JS
 *     bundle as a single asset; the API returns a deployment id and the
 *     auto-generated `<project>.deno.dev` URL.
 *   - `DELETE /projects/{projectId}` to tear the resource down.
 *
 * v0 limitation: this lifecycle implements the minimal happy-path needed for
 * `worker@v1` parity. Multi-asset bundles, custom domains, KV namespaces and
 * the still-evolving organization-id / token-scope semantics are out of scope
 * until the upstream API surface stabilises beyond `/v1/`. Operators who need
 * those features should drive Deno Deploy via their own pipelines.
 */

const BASE_URL = "https://api.deno.com/v1";
const MODULE_CONTENT_TYPE = "application/javascript+module";

export interface DenoDeployCreateInput {
  readonly scriptName: string;
  readonly bundle: Uint8Array;
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly mainModule: string;
}

export interface DenoDeployDescriptor {
  readonly organizationId: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly scriptName: string;
  readonly publicUrl: string;
}

export interface DenoDeployLifecycleClient {
  putScript(
    input: DenoDeployCreateInput,
  ): Promise<DenoDeployDescriptor>;
  deleteScript(input: { readonly scriptName: string }): Promise<boolean>;
  describeScript(
    input: { readonly scriptName: string },
  ): Promise<DenoDeployDescriptor | undefined>;
}

export interface DirectDenoDeployWorkersLifecycleOptions {
  /** Deno Deploy access token (Bearer). */
  readonly accessToken: string;
  /** Optional organization id; required by some paid endpoints. */
  readonly organizationId?: string;
  readonly fetch?: typeof fetch;
}

interface DenoApiProject {
  readonly id: string;
  readonly name: string;
}

interface DenoApiDeployment {
  readonly id: string;
  readonly projectId?: string;
}

export class DirectDenoDeployWorkersLifecycle
  implements DenoDeployLifecycleClient {
  readonly #accessToken: string;
  readonly #organizationId: string;
  readonly #fetch: typeof fetch;
  /** Cache of `scriptName -> projectId` resolved against the API. */
  readonly #projects = new Map<string, string>();

  constructor(options: DirectDenoDeployWorkersLifecycleOptions) {
    this.#accessToken = options.accessToken;
    this.#organizationId = options.organizationId ?? "default";
    this.#fetch = options.fetch ?? fetch;
  }

  async putScript(
    input: DenoDeployCreateInput,
  ): Promise<DenoDeployDescriptor> {
    const projectId = await this.#ensureProject(input.scriptName);
    const deployment = await this.#createDeployment(projectId, input);
    return {
      organizationId: this.#organizationId,
      projectId,
      deploymentId: deployment.id,
      scriptName: input.scriptName,
      publicUrl: `https://${input.scriptName}.deno.dev`,
    };
  }

  async deleteScript(
    input: { readonly scriptName: string },
  ): Promise<boolean> {
    const projectId = this.#projects.get(input.scriptName) ??
      await this.#lookupProject(input.scriptName);
    if (!projectId) return false;
    const url = `${BASE_URL}/projects/${projectId}`;
    const response = await this.#fetch(url, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.#accessToken}` },
    });
    if (response.status === 404) {
      this.#projects.delete(input.scriptName);
      return false;
    }
    await ensureOk(response, `deno-deploy:DeleteProject ${input.scriptName}`);
    this.#projects.delete(input.scriptName);
    return true;
  }

  async describeScript(
    input: { readonly scriptName: string },
  ): Promise<DenoDeployDescriptor | undefined> {
    const projectId = this.#projects.get(input.scriptName) ??
      await this.#lookupProject(input.scriptName);
    if (!projectId) return undefined;
    return {
      organizationId: this.#organizationId,
      projectId,
      // describe does not enumerate deployments; surface the latest pointer
      // when the API exposes it. For v0 we leave it implicit.
      deploymentId: "current",
      scriptName: input.scriptName,
      publicUrl: `https://${input.scriptName}.deno.dev`,
    };
  }

  async #ensureProject(scriptName: string): Promise<string> {
    const cached = this.#projects.get(scriptName);
    if (cached) return cached;
    const existing = await this.#lookupProject(scriptName);
    if (existing) {
      this.#projects.set(scriptName, existing);
      return existing;
    }
    const created = await this.#createProject(scriptName);
    this.#projects.set(scriptName, created);
    return created;
  }

  /**
   * Verify-only: list projects in the configured organization with a hard
   * limit. Returns the raw `Response` so the connector can render a verify
   * result without throwing.
   */
  listProjectsResponse(): Promise<Response> {
    const url =
      `${BASE_URL}/organizations/${this.#organizationId}/projects?limit=1`;
    return this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#accessToken}` },
    });
  }

  async #lookupProject(scriptName: string): Promise<string | undefined> {
    const url =
      `${BASE_URL}/organizations/${this.#organizationId}/projects?name=${
        encodeURIComponent(scriptName)
      }`;
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#accessToken}` },
    });
    if (response.status === 404) return undefined;
    await ensureOk(response, `deno-deploy:ListProjects ${scriptName}`);
    try {
      const body = await response.json() as DenoApiProject[];
      const match = body.find((p) => p.name === scriptName);
      return match?.id;
    } catch {
      return undefined;
    }
  }

  async #createProject(scriptName: string): Promise<string> {
    const url = `${BASE_URL}/organizations/${this.#organizationId}/projects`;
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: scriptName }),
    });
    await ensureOk(response, `deno-deploy:CreateProject ${scriptName}`);
    const body = await response.json() as DenoApiProject;
    return body.id;
  }

  async #createDeployment(
    projectId: string,
    input: DenoDeployCreateInput,
  ): Promise<DenoApiDeployment> {
    const url = `${BASE_URL}/projects/${projectId}/deployments`;
    const form = new FormData();
    const metadata = {
      entryPointUrl: input.mainModule,
      compatibilityDate: input.compatibilityDate,
      compatibilityFlags: input.compatibilityFlags
        ? [...input.compatibilityFlags]
        : [],
      envVars: input.env ?? {},
    };
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    const buffer = new ArrayBuffer(input.bundle.byteLength);
    new Uint8Array(buffer).set(input.bundle);
    form.append(
      input.mainModule,
      new Blob([buffer], { type: MODULE_CONTENT_TYPE }),
      input.mainModule,
    );
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#accessToken}` },
      body: form,
    });
    await ensureOk(
      response,
      `deno-deploy:CreateDeployment ${input.scriptName}`,
    );
    return await response.json() as DenoApiDeployment;
  }
}

interface DenoDeployErrorBody {
  readonly message?: string;
  readonly error?: string;
}

async function ensureOk(response: Response, context: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const body = JSON.parse(text) as DenoDeployErrorBody;
        if (body.message) detail = body.message;
        else if (body.error) detail = body.error;
        else detail = text;
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
