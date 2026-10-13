# Updating

Review the target commit, both database migrations, and runner compatibility before updating.
Migrations are forward-only. A predecessor can serve again only if it accepts the new schema;
an additive change alone does not establish that compatibility.

## Bun and PostgreSQL

Follow the [distribution README](https://github.com/tako0614/takosumi/blob/main/deploy/node-postgres/README.md).
Keep backup evidence, build the new checkout, stop the old accounts service, run the
`migrations` service once, and start the new service after success. Compose migrates both
Accounts and control-plane schemas. Do not migrate while old and new services serve together.

The stock distribution has no OpenTofu runner. Custom compositions must verify their
runner protocol against the new service. Check sign-in, existing Capsule/Run reads, and
credential-dependent operations in your own test Workspace after updating.

## Cloudflare

Accounts D1 and control D1 have separate schema owners. Review their plans, backup evidence,
and application sequence before publishing. Use the
[Control D1 schema predeploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/control-d1-schema-predeploy.md) and
[platform worker deploy](https://github.com/tako0614/takosumi/blob/main/docs/operations/platform-worker-deploy.md) runbooks.
Request-time schema bootstrap is not an upgrade procedure for an existing deployment.

## Failure handling

Record whether failure occurred before or after durable state was touched. After mutation,
retain the fence and execution evidence, verify the applied schema, and repair forward.
A predecessor Worker Version or image alone does not prove database compatibility.
Do not use automatic down migrations or blind retries.
