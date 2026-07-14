import {
  type PasskeyHttpOptions,
  type UpstreamOAuthOptions,
  upstreamOAuthOptionsFromEnvironment,
} from "@takosjp/takosumi-accounts-service";
import {
  optionalIntegerOption,
  optionalStringOption,
} from "./cli-options.ts";

export function buildUpstreamOAuthOptions(
  options: Record<string, string | boolean>,
): UpstreamOAuthOptions | undefined {
  const descriptors = optionalStringOption(options, "upstreamProviders");
  const subjectSecret = optionalStringOption(options, "subjectSecret");
  const sessionTtlMs = optionalIntegerOption(options, "upstreamSessionTtlMs");
  return upstreamOAuthOptionsFromEnvironment({
    ...process.env,
    ...(descriptors
      ? { TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: descriptors }
      : {}),
    ...(subjectSecret
      ? { TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: subjectSecret }
      : {}),
    ...(sessionTtlMs !== undefined
      ? {
          TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS: String(sessionTtlMs),
        }
      : {}),
  });
}

export function buildPasskeyOptions(
  options: Record<string, string | boolean>,
): PasskeyHttpOptions | undefined {
  const rpId = optionalStringOption(options, "passkeyRpId");
  const rpName = optionalStringOption(options, "passkeyRpName");
  const origin = optionalStringOption(options, "passkeyOrigin");
  const sessionTtlMs = optionalIntegerOption(options, "passkeySessionTtlMs");
  if (!rpId && !rpName && !origin && sessionTtlMs === undefined) {
    return undefined;
  }
  if (!rpId || !rpName || !origin) {
    throw new TypeError(
      "Passkeys require --passkey-rp-id, --passkey-rp-name, and --passkey-origin",
    );
  }
  return { rpId, rpName, origin, sessionTtlMs };
}
