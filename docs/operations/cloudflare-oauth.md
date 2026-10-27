# Cloudflare OAuth provider connections

Cloudflare OAuth is a credential setup helper for a user-owned Cloudflare provider. It does not change Run, ProviderBinding, or Workspace authority. The dashboard shows OAuth only when the deployment has installed a complete helper. API-token setup remains available as a fallback. App domain inputs remain repository-declared variables: the OAuth publisher domain does not fix the domains an installed app can use.

## Register the client

Use [Cloudflare OAuth client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) in the owning operator account. For a browser connection use Authorization Code with PKCE S256 and token endpoint authentication `none`; enable `authorization_code` and `refresh_token`. A server-confidential client with `client_secret_post` is also supported. Never reuse Wrangler's client ID.

Register the exact callback URL for the selected deployment, for example:

```text
https://app.takosumi.com/api/v1/connections/oauth/cloudflare/callback?popup=1
```

The `popup=1` callback sends only a public completion result on an attempt-specific same-origin BroadcastChannel, then closes. A Lax, HttpOnly, __Host-prefixed per-attempt cookie on HTTPS binds the authorization to the browser that started it. A copied authorization URL from a different browser cannot attach that browser's Cloudflare credentials to the initiator's Workspace. Legacy redirect presentation also relays the public completion result. Neither presentation exposes code, state or credential values.

Choose only the Cloudflare API scopes needed by the apps supported by this deployment, including account access and Workers subdomain read for connection verification. Scope IDs are obtained from `GET /client/v4/oauth/scopes`; they are not Wrangler's colon-delimited legacy scope names. Enable offline access/refresh on the registered client and include `offline_access` in the configured request. This helper is not an authorization bypass for resources outside the granted account/scopes.

Clients are private by default, usable by members of their parent Cloudflare account. For arbitrary users, complete Cloudflare's required client name, logo, URL, scopes and publisher-domain TXT verification before promoting the client to public visibility. Public promotion is permanent; it is a separate operator action.

## Configure the owning deployment

Configure through the selected deployment's existing release procedure:

- `TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID`
- `TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI` (the exact registered URI)
- `TAKOSUMI_CLOUDFLARE_OAUTH_SCOPES` (space-separated granted scope IDs)
- `TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET` (existing host-owned secret)
- `TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_SECRET` only for a confidential client; keep it in the host secret store, never in tenant connection material.

Authorization/token URLs default to Cloudflare's documented endpoints. The host may override `TAKOSUMI_CLOUDFLARE_OAUTH_AUTHORIZATION_URL` and `TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL`; code exchange and renewal use the same trusted host endpoint. Client-secret rotation is read from the current host composition and needs no tenant credential rewrite.

## Lifecycle and recovery

Access and refresh tokens are encrypted in the existing connection secret partition. Only the access token is delivered to a runner. A connection discovers exactly one authorized Cloudflare account; multiple accounts require the user to choose an account in consent or provide an account ID under optional account settings. Successful verification remains required before Install.

Renewal is claimed by an atomic CAS on the exact connection and sealed blob before the external refresh call. Competing requests wait for that durable claim and reuse the stored result, without replaying a rotating refresh token. Revocation, changed authority, and stopped Workspaces cannot be overwritten by a late renewal. An ambiguous failed or abandoned renewal requires reconnect; an explicit temporary no-token response releases the claim for a later user retry. it is not automatically replayed because the provider may already have rotated the token. Reconnecting creates a fresh connection; revoke an obsolete connection through the existing management UI.

The default RunnerProfile budget is 15 minutes. The helper refreshes when less than 30 minutes or the selected Run budget plus margin remain, and refuses token responses shorter than 30 minutes. Run dispatch also checks the selected profile's full execution budget plus a two-minute margin against the issued token expiry. A profile that cannot fit in the OAuth access-token lifetime requires a different credential mode or a shorter execution budget.

Verify a real consenting user flow and public-client visibility after registration. Local fixtures and the repository gate do not prove Cloudflare consent, configured scopes or live token rotation. Changing the registration/configuration is separate from shipping dormant helper code. Rollback restores the preceding reviewed Worker/configuration; previously encrypted material remains in the existing schema.
