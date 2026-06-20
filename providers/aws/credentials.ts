/**
 * AWS AssumeRole credential driver (registry-facing).
 *
 * This is the extracted, self-contained form of the vault's AWS AssumeRole mint
 * path (the `Action:"AssumeRole"` branch of `#mintProviderValues`) plus its
 * `#verifyAwsAssumeRole`. The crypto / secret-opening stays in core: the vault
 * opens the sealed source credentials and hands the already-decrypted
 * `{ name: value }` map in; this driver maps those source credentials + the
 * connection's AWS scope hints to the runner-facing `AWS_*` env map and the
 * provider-credential mint evidence (mint), or to a structural verify result
 * (verify). The network-facing STS exchange lives in `./connection.ts`.
 *
 * Behavior is byte-identical to the in-vault path:
 *   - The web-identity token-file contract (`AWS_WEB_IDENTITY_TOKEN_FILE` +
 *     `AWS_ROLE_ARN` present) passes through, only defaulting `AWS_ROLE_ARN` to
 *     the connection's `awsRoleArn`, with static evidence.
 *   - Otherwise the source `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are
 *     required; the region falls back through `awsRegion` -> `AWS_REGION` ->
 *     `AWS_DEFAULT_REGION` -> `us-east-1`; an STS AssumeRole mints temporary
 *     credentials, and the result env carries the assumed credentials plus the
 *     region with `aws_sts_assume_role` evidence.
 *
 * The `staticEvidence` factory the vault builds inline is passed in by the
 * caller so the temporary-vs-static evidence shape stays a single source.
 */
import type { Connection } from "takosumi-contract/connections";
import { providerEnvRule } from "takosumi-contract/provider-env-rules";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";
import {
  assumeAwsRole,
  awsRoleSessionName,
  AwsConnectionError,
  type AwsFetch,
} from "./connection.ts";

/**
 * Error raised when the AWS mint preconditions fail. The `code` mirrors the
 * deploy-control error codes the vault raises so the caller can translate it
 * identically to the in-vault `ConnectionVaultError`. Re-exported here so a
 * caller only needs to import from this driver module. The network-facing
 * exchange in `./connection.ts` raises the same class.
 */
export { AwsConnectionError } from "./connection.ts";

/** Successful mint output: the `AWS_*` env map plus mint evidence. */
export interface AwsAssumeRoleMintResult {
  readonly values: Readonly<Record<string, string>>;
  readonly evidence: ProviderCredentialMintEvidence;
}

/** Injected seams so the mint/verify exchange is unit-testable without network. */
export interface AwsDriverDeps {
  readonly fetch?: AwsFetch;
  readonly now?: () => Date;
}

/**
 * Mint AWS provider credentials for an AssumeRole connection.
 *
 * Mirrors the vault's `#mintProviderValues` AWS branch exactly. The caller
 * (vault) has already opened the sealed blob, checked expiry, and decided the
 * `delivery` mode; it must pass:
 *
 * @param connection the resolved AWS Connection (its `scopeHints.awsRoleArn`
 *   gates whether AssumeRole applies).
 * @param values the connection's already-decrypted `{ name: value }` map.
 * @param delivery the mint delivery mode (drives `rootOnly` in evidence),
 *   sourced from `ProviderCredentialMintEvidence["delivery"]`.
 * @param staticEvidence the caller's static-evidence factory (the same closure
 *   the vault builds inline), used for the pass-through web-identity case.
 * @param deps injected `fetch` / `now` seams (default to global `fetch` /
 *   `new Date()`).
 * @returns the AWS env map + mint evidence, or `undefined` when AssumeRole does
 *   not apply (non-AWS provider, or no `awsRoleArn` scope hint) so the caller
 *   falls through to its static-secret path unchanged.
 */
export async function mintAwsAssumeRoleCredentials(
  connection: Connection,
  values: Readonly<Record<string, string>>,
  delivery: ProviderCredentialMintEvidence["delivery"],
  staticEvidence: () => ProviderCredentialMintEvidence,
  deps: AwsDriverDeps = {},
): Promise<AwsAssumeRoleMintResult | undefined> {
  if (!isAwsProvider(connection.provider) || !connection.scopeHints?.awsRoleArn) {
    return undefined;
  }
  if (values.AWS_WEB_IDENTITY_TOKEN_FILE && values.AWS_ROLE_ARN) {
    // Web-identity token files are runner-local files. The vault cannot safely
    // materialize them from sealed provider env today, so pass through the
    // explicit file-based contract when an operator has arranged the file in
    // the runner environment.
    return {
      values: {
        ...values,
        AWS_ROLE_ARN: values.AWS_ROLE_ARN || connection.scopeHints.awsRoleArn,
      },
      evidence: staticEvidence(),
    };
  }
  const accessKeyId = values.AWS_ACCESS_KEY_ID;
  const secretAccessKey = values.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new AwsConnectionError(
      `aws assume-role connection ${connection.id} requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as source credentials`,
    );
  }
  const region =
    connection.scopeHints.awsRegion ??
    values.AWS_REGION ??
    values.AWS_DEFAULT_REGION ??
    "us-east-1";
  const assumed = await assumeAwsRole(
    {
      accessKeyId,
      secretAccessKey,
      sessionToken: values.AWS_SESSION_TOKEN,
      roleArn: connection.scopeHints.awsRoleArn,
      externalId: connection.scopeHints.awsExternalId,
      region,
      sessionName: awsRoleSessionName(connection.id),
    },
    deps,
  );
  return {
    values: {
      AWS_ACCESS_KEY_ID: assumed.accessKeyId,
      AWS_SECRET_ACCESS_KEY: assumed.secretAccessKey,
      AWS_SESSION_TOKEN: assumed.sessionToken,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: values.AWS_DEFAULT_REGION ?? region,
    },
    evidence: {
      providerEnvId: connection.id,
      connectionId: connection.id,
      provider: connection.provider,
      delivery,
      rootOnly: delivery === "generated_root_variable",
      temporary: true,
      ttlEnforced: true,
      expiresAt: assumed.expiresAt,
      ttlSeconds: assumed.ttlSeconds,
      issuer: "aws_sts_assume_role",
    },
  };
}

/**
 * Verify an AWS AssumeRole connection by performing a dry AssumeRole exchange.
 * Extracted verbatim from the vault's `#verifyAwsAssumeRole`: the same
 * precondition checks (role ARN scope hint + source access/secret keys), the
 * same region fallback, and the same success/detail mapping.
 *
 * @param connection the AWS Connection under test.
 * @param values the already-decrypted source credential map.
 * @param deps injected `fetch` / `now` seams.
 */
export async function verifyAwsAssumeRole(
  connection: Connection,
  values: Readonly<Record<string, string>>,
  deps: AwsDriverDeps = {},
): Promise<{ readonly ok: boolean; readonly detail?: string }> {
  if (!connection.scopeHints?.awsRoleArn) {
    return {
      ok: false,
      detail: "aws verification requires scopeHints.awsRoleArn for AssumeRole",
    };
  }
  const accessKeyId = values.AWS_ACCESS_KEY_ID;
  const secretAccessKey = values.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return {
      ok: false,
      detail:
        "aws verification requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as source credentials",
    };
  }
  const region =
    connection.scopeHints.awsRegion ??
    values.AWS_REGION ??
    values.AWS_DEFAULT_REGION ??
    "us-east-1";
  try {
    await assumeAwsRole(
      {
        accessKeyId,
        secretAccessKey,
        sessionToken: values.AWS_SESSION_TOKEN,
        roleArn: connection.scopeHints.awsRoleArn,
        externalId: connection.scopeHints.awsExternalId,
        region,
        sessionName: awsRoleSessionName(connection.id),
      },
      deps,
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * True when `provider` resolves to the AWS provider family. Mirrors the vault's
 * `isAwsProvider`, which keys off the `provider-env-rules` short-name match.
 */
function isAwsProvider(provider: string): boolean {
  return providerEnvRule(provider)?.shortName === "aws";
}
