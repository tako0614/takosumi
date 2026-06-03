# OpenTofu Deploy Control Sample

This sample submits the current repository as an OpenTofu module to the Takosumi Deploy Control API with `tako0614/takosumi/actions/deploy@v1`.

Required GitHub Actions secrets:

- `TAKOSUMI_REMOTE_URL`: Takosumi service base URL.
- `TAKOSUMI_DEPLOY_CONTROL_TOKEN`: Bearer accepted by the Deploy Control API (`/v1/plan-runs`, `/v1/apply-runs`, read-only Installation projection routes).

Required GitHub Actions variables:

- `TAKOSUMI_SPACE_ID`: Space id that will own the Installation.
- `TAKOSUMI_REQUIRED_PROVIDERS`: comma-separated OpenTofu provider source addresses reviewed for this module.
