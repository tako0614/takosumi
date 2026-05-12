# Direct Deploy Sample

This sample shows the raw unmanaged deploy path. It submits an explicit Takosumi
manifest to the kernel with `tako0614/takosumi/actions/deploy@v1`.

Required GitHub Actions secrets:

- `TAKOSUMI_REMOTE_URL`: Takosumi kernel base URL.
- `TAKOSUMI_DEPLOY_TOKEN`: Bearer accepted by `POST /v1/deployments`.

This path does not create AppInstallation ownership, billing, grants, or OIDC
client records. Use `takosumi-git` and Takosumi Accounts for Git URL install.
