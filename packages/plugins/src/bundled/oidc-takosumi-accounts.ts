/**
 * Bundled `oidc@v1` KernelPlugin factory backed by Takosumi Accounts.
 *
 * Each Installation that declares an `oidc` component gets a fresh OIDC
 * client registered with the operator's Takosumi Accounts deployment at
 * install time. Outputs surface `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` /
 * `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URIS` for downstream `use:` edges.
 *
 * In tests the default `InMemoryTakosumiAccountsClient` generates
 * deterministic-looking credentials per installationId.
 */

import type {
  KernelPlugin,
  KernelPluginApplyContext,
} from "takosumi-contract/plugin";
import { KIND_URI_OIDC } from "./_kinds.ts";

/**
 * Minimal Takosumi Accounts client surface the OIDC provider needs. Real
 * deployments inject an HTTP-backed client that posts to the operator's
 * Takosumi Accounts identity plane; tests inject the in-memory fake.
 */
export interface TakosumiAccountsOidcClient {
  registerClient(input: {
    readonly installationId: string;
    readonly redirectUris: readonly string[];
    readonly scopes: readonly string[];
  }): Promise<{
    readonly issuerUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
  }>;
  deregisterClient(input: {
    readonly installationId: string;
    readonly clientId: string;
  }): Promise<void>;
}

export interface TakosumiAccountsOidcProviderOptions {
  readonly accountsBaseUrl?: string;
  readonly client?: TakosumiAccountsOidcClient;
}

export function takosumiAccountsOidcProvider(
  opts: TakosumiAccountsOidcProviderOptions = {},
): KernelPlugin {
  const issuerBase = opts.accountsBaseUrl ?? "https://accounts.takosumi.test";
  const client = opts.client ??
    new InMemoryTakosumiAccountsOidcClient(issuerBase);
  return {
    name: "@takos/oidc-takosumi-accounts",
    version: "1.0.0",
    provides: [KIND_URI_OIDC],
    capabilities: [
      "authorization-code-pkce",
      "client-credentials",
      "refresh-token",
      "id-token-signing",
    ],
    async apply(ctx: KernelPluginApplyContext) {
      const redirectPaths = readStringArray(ctx, "redirectPaths");
      const scopes = readStringArray(ctx, "scopes");
      const registered = await client.registerClient({
        installationId: ctx.installationId,
        redirectUris: redirectPaths,
        scopes,
      });
      return {
        providerResourceId: registered.clientId,
        outputs: {
          OIDC_ISSUER_URL: registered.issuerUrl,
          OIDC_CLIENT_ID: registered.clientId,
          OIDC_CLIENT_SECRET: registered.clientSecret,
          OIDC_REDIRECT_URIS: redirectPaths.join(" "),
        },
      };
    },
    async destroy(ctx) {
      await client.deregisterClient({
        installationId: ctx.installationId,
        clientId: ctx.providerResourceId,
      });
    },
  };
}

/**
 * Read either `Component.<field>` (= the convenience top-level form used
 * by `oidc` in the v1 AppSpec) or `Component.spec.<field>` as a fallback
 * for operator-defined kinds that use the structured `spec:` block.
 */
function readStringArray(
  ctx: KernelPluginApplyContext,
  field: "redirectPaths" | "scopes",
): readonly string[] {
  const direct = (ctx.component as unknown as Record<string, unknown>)[field];
  if (Array.isArray(direct)) return direct.filter(isNonEmptyString);
  const spec = ctx.component.spec;
  if (spec && typeof spec === "object") {
    const fromSpec = (spec as Record<string, unknown>)[field];
    if (Array.isArray(fromSpec)) return fromSpec.filter(isNonEmptyString);
  }
  return [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * In-memory Takosumi Accounts client used as the default for tests and
 * local development. Generates stable-looking client credentials keyed
 * by installation id.
 */
export class InMemoryTakosumiAccountsOidcClient
  implements TakosumiAccountsOidcClient {
  readonly #issuerBase: string;
  readonly #registered = new Map<string, string>();

  constructor(issuerBase: string) {
    this.#issuerBase = issuerBase.replace(/\/+$/, "");
  }

  registerClient(input: {
    readonly installationId: string;
    readonly redirectUris: readonly string[];
    readonly scopes: readonly string[];
  }): Promise<{
    readonly issuerUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
  }> {
    const clientId = `client_${input.installationId}`;
    const clientSecret = `secret_${input.installationId}_${randomSuffix()}`;
    this.#registered.set(clientId, input.installationId);
    return Promise.resolve({
      issuerUrl: `${this.#issuerBase}/oidc/${input.installationId}`,
      clientId,
      clientSecret,
    });
  }

  deregisterClient(input: {
    readonly installationId: string;
    readonly clientId: string;
  }): Promise<void> {
    this.#registered.delete(input.clientId);
    void input.installationId;
    return Promise.resolve();
  }

  size(): number {
    return this.#registered.size;
  }
}

function randomSuffix(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
