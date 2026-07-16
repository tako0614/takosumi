const FORWARDED_KEYS = [
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TMPDIR",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
];

const PROVIDER_CREDENTIAL_KEY =
  /(?:^|_)(?:ACCESS_KEY|API_KEY|AUTH|CLIENT_SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY|SECRET|SESSION_TOKEN|TOKEN)(?:_|$)|^(?:AWS|AZURE|CLOUDFLARE|DIGITALOCEAN|GCP|GOOGLE|HCLOUD|KUBE|TAKOSUMI)_/i;

export function detectProviderCredentialEnvironmentKeys(environment) {
  return Object.keys(environment)
    .filter((key) => PROVIDER_CREDENTIAL_KEY.test(key))
    .sort();
}

function proxyHasCredentials(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.username !== "" || url.password !== "";
  } catch {
    return true;
  }
}

export function buildSanitizedProviderProofEnvironment(
  source,
  { home, overrides = {} },
) {
  const environment = {};
  for (const key of FORWARDED_KEYS) {
    const value = source[key];
    if (typeof value !== "string" || value === "") continue;
    if (/proxy$/i.test(key) && proxyHasCredentials(value)) continue;
    environment[key] = value;
  }
  environment.HOME = home;
  Object.assign(environment, overrides);
  const credentialEnvironmentKeys =
    detectProviderCredentialEnvironmentKeys(environment);
  if (credentialEnvironmentKeys.length > 0) {
    throw new Error(
      `provider proof environment retained credential keys: ${credentialEnvironmentKeys.join(", ")}`,
    );
  }
  return {
    environment,
    evidence: {
      mode: "explicit-allowlist",
      forwardedKeys: Object.keys(environment).sort(),
      credentialEnvironmentKeys,
      credentialsUsed: credentialEnvironmentKeys.length > 0,
    },
  };
}
