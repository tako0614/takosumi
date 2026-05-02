/**
 * `DirectAzureContainerAppsLifecycle` — drives Azure Container Apps via the
 * ARM REST API. Uses an operator-supplied OAuth bearer token.
 */

const ARM_API_VERSION = "2024-03-01";
const ARM_BASE = "https://management.azure.com";

export interface AzureContainerAppDescriptor {
  readonly serviceName: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  readonly fqdn?: string;
  readonly internalHost: string;
  readonly internalPort: number;
}

export interface AzureContainerAppCreateInput {
  readonly serviceName: string;
  readonly image: string;
  readonly cpu: number;
  readonly memoryGib: number;
  readonly minReplicas: number;
  readonly maxReplicas: number;
  readonly internalPort: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DirectAzureContainerAppsLifecycleOptions {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  /**
   * Fully-qualified resource ID of the Container Apps managed environment.
   */
  readonly environmentResourceId: string;
  /** Operator-supplied OAuth bearer token. */
  readonly bearerToken: string;
  readonly fetch?: typeof fetch;
}

export class DirectAzureContainerAppsLifecycle {
  readonly #opts: DirectAzureContainerAppsLifecycleOptions;

  constructor(options: DirectAzureContainerAppsLifecycleOptions) {
    this.#opts = options;
  }

  async createService(
    input: AzureContainerAppCreateInput,
  ): Promise<AzureContainerAppDescriptor> {
    const body = {
      location: this.#opts.region,
      properties: {
        managedEnvironmentId: this.#opts.environmentResourceId,
        configuration: {
          ingress: {
            external: true,
            targetPort: input.internalPort,
            transport: "auto",
          },
        },
        template: {
          containers: [
            {
              name: input.serviceName,
              image: input.image,
              resources: {
                cpu: input.cpu,
                memory: `${input.memoryGib}Gi`,
              },
              env: input.env
                ? Object.entries(input.env).map(([name, value]) => ({
                  name,
                  value,
                }))
                : undefined,
            },
          ],
          scale: {
            minReplicas: input.minReplicas,
            maxReplicas: input.maxReplicas,
          },
        },
      },
    };
    const response = await this.#armFetch(
      "PUT",
      this.#resourceUrl(input.serviceName),
      body,
    );
    if (response.status === 409 /* already exists, treat as idempotent */) {
      // fall through to describe below
    } else if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `azure-containerapps:CreateService ${input.serviceName} failed: ` +
          `HTTP ${response.status} ${response.statusText}${
            text ? `: ${text}` : ""
          }`,
      );
    }
    const fqdn = await this.#fetchFqdn(input.serviceName);
    if (!fqdn) {
      throw new Error(
        `azure-containerapps:CreateService ${input.serviceName}: ARM ` +
          `response did not include properties.configuration.ingress.fqdn; ` +
          `refusing to fabricate an Azure Container Apps FQDN.`,
      );
    }
    return {
      serviceName: input.serviceName,
      subscriptionId: this.#opts.subscriptionId,
      resourceGroup: this.#opts.resourceGroup,
      region: this.#opts.region,
      environmentName: this.#opts.environmentName,
      fqdn,
      internalHost:
        `${input.serviceName}.internal.${this.#opts.environmentName}`,
      internalPort: input.internalPort,
    };
  }

  async describeService(
    input: { readonly serviceName: string },
  ): Promise<AzureContainerAppDescriptor | undefined> {
    const response = await this.#armFetch(
      "GET",
      this.#resourceUrl(input.serviceName),
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `azure-containerapps:DescribeService ${input.serviceName} failed: ` +
          `HTTP ${response.status} ${response.statusText}${
            text ? `: ${text}` : ""
          }`,
      );
    }
    const json = await response.json().catch(() => ({} as Record<
      string,
      unknown
    >));
    const fqdn = readFqdn(json);
    if (!fqdn) {
      throw new Error(
        `azure-containerapps:DescribeService ${input.serviceName}: ARM ` +
          `response did not include properties.configuration.ingress.fqdn; ` +
          `refusing to fabricate an Azure Container Apps FQDN.`,
      );
    }
    return {
      serviceName: input.serviceName,
      subscriptionId: this.#opts.subscriptionId,
      resourceGroup: this.#opts.resourceGroup,
      region: this.#opts.region,
      environmentName: this.#opts.environmentName,
      fqdn,
      internalHost:
        `${input.serviceName}.internal.${this.#opts.environmentName}`,
      internalPort: 0,
    };
  }

  async deleteService(
    input: { readonly serviceName: string },
  ): Promise<boolean> {
    const response = await this.#armFetch(
      "DELETE",
      this.#resourceUrl(input.serviceName),
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `azure-containerapps:DeleteService ${input.serviceName} failed: ` +
          `HTTP ${response.status} ${response.statusText}${
            text ? `: ${text}` : ""
          }`,
      );
    }
    return true;
  }

  async #fetchFqdn(serviceName: string): Promise<string | undefined> {
    try {
      const desc = await this.describeService({ serviceName });
      return desc?.fqdn;
    } catch {
      return undefined;
    }
  }

  #resourceUrl(serviceName: string): string {
    return `${ARM_BASE}/subscriptions/${this.#opts.subscriptionId}` +
      `/resourceGroups/${this.#opts.resourceGroup}` +
      `/providers/Microsoft.App/containerApps/${serviceName}` +
      `?api-version=${ARM_API_VERSION}`;
  }

  #armFetch(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response> {
    const f = this.#opts.fetch ?? fetch;
    const headers = new Headers({
      "accept": "application/json",
      "authorization": `Bearer ${this.#opts.bearerToken}`,
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    return f(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}

function readFqdn(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const props = (json as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return undefined;
  const config = (props as { configuration?: unknown }).configuration;
  if (config && typeof config === "object") {
    const ingress = (config as { ingress?: unknown }).ingress;
    if (ingress && typeof ingress === "object") {
      const fqdn = (ingress as { fqdn?: unknown }).fqdn;
      if (typeof fqdn === "string") return fqdn;
    }
  }
  const fqdn = (props as { fqdn?: unknown }).fqdn;
  if (typeof fqdn === "string") return fqdn;
  return undefined;
}
