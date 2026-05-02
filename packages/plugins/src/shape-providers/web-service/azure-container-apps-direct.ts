// Direct Azure Container Apps lifecycle — calls the Azure REST API with an
// operator-provided bearer token. Mirrors the structure of `aws-fargate.ts` /
// `cloud-run.ts` direct adapters.

import type {
  AzureContainerAppCreateInput,
  AzureContainerAppDescriptor,
  AzureContainerAppsLifecycleClient,
} from "./azure-container-apps.ts";

export interface DirectAzureContainerAppsLifecycleOptions {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  readonly environmentResourceId: string;
  readonly bearerToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiVersion?: string;
}

const DEFAULT_API_VERSION = "2024-03-01";

export class DirectAzureContainerAppsLifecycle
  implements AzureContainerAppsLifecycleClient {
  readonly #subscriptionId: string;
  readonly #resourceGroup: string;
  readonly #region: string;
  readonly #environmentResourceId: string;
  readonly #bearerToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiVersion: string;

  constructor(options: DirectAzureContainerAppsLifecycleOptions) {
    this.#subscriptionId = options.subscriptionId;
    this.#resourceGroup = options.resourceGroup;
    this.#region = options.region;
    this.#environmentResourceId = options.environmentResourceId;
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  }

  async createService(
    input: AzureContainerAppCreateInput,
  ): Promise<AzureContainerAppDescriptor> {
    const url = this.#serviceUrl(input.serviceName);
    const body = {
      location: this.#region,
      properties: {
        managedEnvironmentId: this.#environmentResourceId,
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
    const response = await this.#fetch(url, {
      method: "PUT",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `azure container apps create failed: ${response.status} ${await response
          .text()}`,
      );
    }
    const fqdn = await this.#readFqdn(response);
    return {
      serviceName: input.serviceName,
      subscriptionId: this.#subscriptionId,
      resourceGroup: this.#resourceGroup,
      region: this.#region,
      environmentName: this.#environmentResourceId.split("/").at(-1) ??
        "takosumi",
      fqdn,
      internalHost: fqdn ?? `${input.serviceName}.internal`,
      internalPort: input.internalPort,
    };
  }

  async describeService(
    input: { readonly serviceName: string },
  ): Promise<AzureContainerAppDescriptor | undefined> {
    const response = await this.#fetch(this.#serviceUrl(input.serviceName), {
      method: "GET",
      headers: this.#headers(),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `azure container apps describe failed: ${response.status} ${await response
          .text()}`,
      );
    }
    const fqdn = await this.#readFqdn(response);
    return {
      serviceName: input.serviceName,
      subscriptionId: this.#subscriptionId,
      resourceGroup: this.#resourceGroup,
      region: this.#region,
      environmentName: this.#environmentResourceId.split("/").at(-1) ??
        "takosumi",
      fqdn,
      internalHost: fqdn ?? `${input.serviceName}.internal`,
      internalPort: 0,
    };
  }

  async deleteService(
    input: { readonly serviceName: string },
  ): Promise<boolean> {
    const response = await this.#fetch(this.#serviceUrl(input.serviceName), {
      method: "DELETE",
      headers: this.#headers(),
    });
    if (response.status === 404) return false;
    return response.ok;
  }

  #serviceUrl(serviceName: string): string {
    return `https://management.azure.com/subscriptions/${this.#subscriptionId}/resourceGroups/${this.#resourceGroup}/providers/Microsoft.App/containerApps/${serviceName}?api-version=${this.#apiVersion}`;
  }

  #headers(): HeadersInit {
    return {
      "authorization": `Bearer ${this.#bearerToken}`,
      "content-type": "application/json",
    };
  }

  async #readFqdn(response: Response): Promise<string | undefined> {
    try {
      const json = await response.clone().json() as {
        properties?: { configuration?: { ingress?: { fqdn?: string } } };
      };
      return json.properties?.configuration?.ingress?.fqdn;
    } catch {
      return undefined;
    }
  }
}
