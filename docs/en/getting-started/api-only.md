# Run only the API

This is the smallest setup for checking the API during development. It needs Bun
and Git. Data stays in memory and is lost on restart. The dashboard and runner do
not start.

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install

TAKOSUMI_DEV_MODE=1 \
TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token \
PORT=8788 \
bun core/index.ts
```

In another terminal:

```bash
curl http://127.0.0.1:8788/api/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

If it returns JSON, the API is running.

To try the dashboard, sign-in, and runner as well, follow the
[Quickstart](./quickstart.md). To operate a production installation, see
[Running it yourself](../concepts/self-host.md).
