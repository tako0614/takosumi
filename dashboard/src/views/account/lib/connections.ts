/**
 * Provider presentation descriptors for the connections tab: the guided
 * token-creation helpers and credential field catalogs shown in the register
 * form. Pure client-side presentation data — the Connection CRUD itself goes
 * through `lib/control-api.ts` (`/api/v1/connections*`).
 */
import { type MessageKey, t } from "../../../i18n/index.ts";

/**
 * One env-name field a provider exposes in the register form. `secret: true`
 * fields render as `type=password`. The cloudflare field set is hardcoded here
 * for Phase 1 (the only guided provider); later providers extend the map.
 */
export interface ProviderCredentialField {
  readonly envName: string;
  readonly label: string;
  readonly required: boolean;
  readonly secret: boolean;
  readonly placeholder?: string;
}

/**
 * A guided credential-creation helper for a provider. The point is to remove
 * the "I don't know what to create" wall: we deep-link the user to the
 * provider's OWN token-creation screen (pre-filled where possible), they click
 * through on the provider's site, then paste the resulting token back. The
 * browser flow is a guided link plus the existing paste path. The token still
 * arrives via the same write-only create-connection path.
 */
export interface ProviderTokenHelper {
  /** The env name the pasted credential is stored under. */
  readonly envName: string;
  /** Deep-link to the provider's own "create token" screen. */
  readonly createTokenUrl: string;
  /** Plain-language, numbered steps shown next to the deep-link button. */
  readonly steps: readonly string[];
}

export interface ProviderDescriptor {
  /** Stable UI option id. */
  readonly provider: string;
  /** Canonical OpenTofu provider source stored on the ProviderConnection. */
  readonly providerSource?: string;
  /** Additional stored provider sources that should use this descriptor label. */
  readonly providerAliases?: readonly string[];
  readonly label: string;
  readonly fields: readonly ProviderCredentialField[];
  /**
   * Optional guided-token helper. When present, the connections screen leads
   * with provider-specific setup copy, deep-link, and paste. Absent providers
   * keep the plain field form as the only path.
   */
  readonly tokenHelper?: ProviderTokenHelper;
  /**
   * Optional, additive setup guide for multi-field providers (no single-token
   * paste). It deep-links to the provider's own credential page and lists
   * plain-language steps ABOVE the field form, without hiding any field — so
   * AWS/GCP/etc. keep every input visible while still removing the "where do I
   * get this?" wall. Distinct from `tokenHelper`, which is the single-token path.
   */
  readonly setupGuide?: {
    readonly url: string;
    readonly steps: readonly string[];
  };
  /**
   * Whether a real third-party OAuth helper MIGHT be available for this
   * provider (operator-gated). The screen probes the backend before showing an
   * OAuth button; this only marks which providers are worth probing.
   */
  readonly oauthCandidate?: boolean;
}

const providerCopy = (key: MessageKey) => t(key);

/**
 * Cloudflare "Create API Token" deep-link. Cloudflare's dashboard accepts a
 * `permissionGroupKeys` query on the custom-token screen to pre-tick permission
 * rows, so the user lands on a screen already scoped to what an OpenTofu deploy
 * needs (Workers / DNS / R2 edit) instead of a blank custom token. This opens
 * Cloudflare's OWN screen — the user creates the token there and pastes it
 * back; we never see their dashboard credentials.
 */
export const CLOUDFLARE_CREATE_TOKEN_URL =
  "https://dash.cloudflare.com/profile/api-tokens?" +
  new URLSearchParams({
    // Cloudflare reads this to pre-select permission rows on the custom-token
    // screen. Unknown query values are ignored by Cloudflare, so this degrades to a
    // plain custom-token screen if the format changes — never a broken link.
    permissionGroupKeys: JSON.stringify([
      { key: "workers_scripts", type: "edit" },
      { key: "workers_kv_storage", type: "edit" },
      { key: "workers_r2", type: "edit" },
      { key: "dns_records", type: "edit" },
      { key: "zone", type: "read" },
    ]),
    name: "Takosumi deploy",
  }).toString();

/**
 * Deep-links to each provider's OWN credential-creation page for the additive
 * setup guide. These open the provider's site in a new tab; we never see the
 * dashboard credentials — the user creates the key/token there and pastes the
 * result back into the field form. Unknown query/hash is harmless, so a format
 * change degrades to the provider's plain page, never a broken link.
 */
const AWS_CREATE_KEY_URL = "https://console.aws.amazon.com/iam/home#/users";
const GCP_SERVICE_ACCOUNTS_URL =
  "https://console.cloud.google.com/iam-admin/serviceaccounts";
const HCLOUD_CONSOLE_URL = "https://console.hetzner.cloud/";
const R2_API_TOKENS_URL =
  "https://dash.cloudflare.com/?to=/:account/r2/api-tokens";

/**
 * Guided providers + their credential field sets. Cloudflare has a helper link;
 * the other common providers use provider-specific credential fields with
 * stable names so users don't need the custom service editor for normal
 * OpenTofu cases.
 */
export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    provider: "cloudflare",
    get label() {
      return providerCopy("conn.provider.cloudflare.label");
    },
    oauthCandidate: true,
    tokenHelper: {
      envName: "CLOUDFLARE_API_TOKEN",
      createTokenUrl: CLOUDFLARE_CREATE_TOKEN_URL,
      get steps() {
        return [
          providerCopy("conn.provider.cloudflare.helper.stepOpen"),
          providerCopy("conn.provider.cloudflare.helper.stepCreate"),
          providerCopy("conn.provider.cloudflare.helper.stepPaste"),
        ];
      },
    },
    get fields() {
      return [
        {
          envName: "CLOUDFLARE_API_TOKEN",
          label: providerCopy("conn.provider.cloudflare.apiToken.label"),
          required: true,
          secret: true,
          placeholder: providerCopy(
            "conn.provider.cloudflare.apiToken.placeholder",
          ),
        },
        {
          envName: "CLOUDFLARE_ACCOUNT_ID",
          label: providerCopy("conn.provider.cloudflare.accountId.label"),
          required: true,
          secret: false,
          placeholder: providerCopy(
            "conn.provider.cloudflare.accountId.placeholder",
          ),
        },
      ];
    },
  },
  {
    provider: "aws",
    get label() {
      return providerCopy("conn.provider.aws.label");
    },
    get setupGuide() {
      return {
        url: AWS_CREATE_KEY_URL,
        steps: [
          providerCopy("conn.provider.aws.guide.step1"),
          providerCopy("conn.provider.aws.guide.step2"),
          providerCopy("conn.provider.aws.guide.step3"),
        ],
      };
    },
    get fields() {
      return [
        {
          envName: "AWS_ACCESS_KEY_ID",
          label: providerCopy("conn.provider.aws.accessKeyId.label"),
          required: true,
          secret: false,
          placeholder: "AKIA...",
        },
        {
          envName: "AWS_SECRET_ACCESS_KEY",
          label: providerCopy("conn.provider.aws.secretAccessKey.label"),
          required: true,
          secret: true,
          placeholder: providerCopy(
            "conn.provider.aws.secretAccessKey.placeholder",
          ),
        },
        {
          envName: "AWS_REGION",
          label: providerCopy("conn.provider.aws.region.label"),
          required: true,
          secret: false,
          placeholder: "ap-northeast-1",
        },
        {
          envName: "AWS_SESSION_TOKEN",
          label: providerCopy("conn.provider.aws.sessionToken.label"),
          required: false,
          secret: true,
          placeholder: providerCopy(
            "conn.provider.aws.sessionToken.placeholder",
          ),
        },
      ];
    },
  },
  {
    provider: "gcp",
    get label() {
      return providerCopy("conn.provider.gcp.label");
    },
    get setupGuide() {
      return {
        url: GCP_SERVICE_ACCOUNTS_URL,
        steps: [
          providerCopy("conn.provider.gcp.guide.step1"),
          providerCopy("conn.provider.gcp.guide.step2"),
          providerCopy("conn.provider.gcp.guide.step3"),
        ],
      };
    },
    get fields() {
      return [
        {
          envName: "GOOGLE_CREDENTIALS",
          label: providerCopy("conn.provider.gcp.credentials.label"),
          required: true,
          secret: true,
          placeholder: providerCopy(
            "conn.provider.gcp.credentials.placeholder",
          ),
        },
        {
          envName: "GOOGLE_CLOUD_PROJECT",
          label: providerCopy("conn.provider.gcp.project.label"),
          required: true,
          secret: false,
          placeholder: "my-project",
        },
      ];
    },
  },
  {
    provider: "hcloud",
    providerSource: "hetznercloud/hcloud",
    providerAliases: ["hetznercloud/hcloud"],
    get label() {
      return providerCopy("conn.provider.hcloud.label");
    },
    get setupGuide() {
      return {
        url: HCLOUD_CONSOLE_URL,
        steps: [
          providerCopy("conn.provider.hcloud.guide.step1"),
          providerCopy("conn.provider.hcloud.guide.step2"),
          providerCopy("conn.provider.hcloud.guide.step3"),
        ],
      };
    },
    get fields() {
      return [
        {
          envName: "HCLOUD_TOKEN",
          label: providerCopy("conn.provider.hcloud.token.label"),
          required: true,
          secret: true,
          placeholder: providerCopy("conn.provider.hcloud.token.placeholder"),
        },
      ];
    },
  },
  {
    provider: "s3-compatible",
    providerSource: "hashicorp/aws",
    get label() {
      return providerCopy("conn.provider.s3.label");
    },
    get setupGuide() {
      return {
        url: R2_API_TOKENS_URL,
        steps: [
          providerCopy("conn.provider.s3.guide.step1"),
          providerCopy("conn.provider.s3.guide.step2"),
          providerCopy("conn.provider.s3.guide.step3"),
        ],
      };
    },
    get fields() {
      return [
        {
          envName: "AWS_ACCESS_KEY_ID",
          label: providerCopy("conn.provider.aws.accessKeyId.label"),
          required: true,
          secret: false,
          placeholder: "R2...",
        },
        {
          envName: "AWS_SECRET_ACCESS_KEY",
          label: providerCopy("conn.provider.aws.secretAccessKey.label"),
          required: true,
          secret: true,
          placeholder: providerCopy(
            "conn.provider.aws.secretAccessKey.placeholder",
          ),
        },
        {
          envName: "AWS_REGION",
          label: providerCopy("conn.provider.aws.region.label"),
          required: true,
          secret: false,
          placeholder: "auto",
        },
        {
          envName: "AWS_ENDPOINT_URL_S3",
          label: providerCopy("conn.provider.s3.endpoint.label"),
          required: true,
          secret: false,
          placeholder: "https://<account>.r2.cloudflarestorage.com",
        },
      ];
    },
  },
];

export function providerDescriptor(
  provider: string,
): ProviderDescriptor | undefined {
  return PROVIDERS.find(
    (p) => p.provider === provider || p.providerAliases?.includes(provider),
  );
}
