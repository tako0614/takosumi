# Installer API Deploy Sample

This sample submits the current repository as an AppSpec source to the Takosumi
installer API with `tako0614/takosumi/actions/deploy@v1`.

Required GitHub Actions secrets:

- `TAKOSUMI_REMOTE_URL`: Takosumi kernel base URL.
- `TAKOSUMI_INSTALLER_TOKEN`: Bearer accepted by `/v1/installations/*`.

Required GitHub Actions variables:

- `TAKOSUMI_SPACE_ID`: Space id that will own the Installation.
