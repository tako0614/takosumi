# InstallConfig patch operation

Last updated: 2026-07-17

Use this operation when an app release publishes an immutable
`takosumi.install-config-patch@v1` contribution and the operator has already
selected the exact target InstallConfig row.

## Apply

1. Download the release asset from the operator-approved release. Verify its
   provenance and digest outside this command.
2. Choose the exact target InstallConfig id. For a pre-install template, use
   the reviewed shared config id; for an existing Capsule, read its exact
   `installConfigId`. Do not infer the target from the app name, Git URL, tag,
   or Store listing.
3. Review the JSON fields, lifecycle commands, executor, provider-credential
   opt-in, Output allowlist, and Interface binding proposals.
4. Apply the exact file:

   ```sh
   takosumi install-configs patch "$INSTALL_CONFIG_ID" \
     --file ./install-config-patch.json \
     --url "$TAKOSUMI_DEPLOY_CONTROL_URL" \
     --token "$TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
     --json
   ```

5. Read the returned InstallConfig and confirm `updatedAt`, the lifecycle
   policy, Output allowlist, and Interface blueprints before creating a new
   reviewed Plan.

The patch does not alter an already reviewed Plan. A later plan captures the
updated InstallConfig revision. It also does not download a release, discover a
repository manifest, update a Cloud reference config, or select an app/version
automatically.

If the patch contains an `installing_principal` Interface binding proposal,
target a shared config before Capsule creation so the authenticated create flow
can resolve the installer into an exact Principal. Takosumi rejects that
placeholder on a Workspace-scoped per-install config; it never guesses the
original installer during a later release update.

## Failure and rollback

Unknown kinds/fields and invalid declarations fail before storage. Keep the
previous reviewed InstallConfig projection in operator evidence. Rollback is a
second explicit patch file containing the previous mutable values, followed by
a fresh reviewed Plan. Do not retry a failed lifecycle action by replaying an
already consumed Plan.
