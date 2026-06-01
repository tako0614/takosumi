# Next Steps {#next-steps}

After creating an Installation, use PlatformService bindings for databases, identity, buckets, queues, and other
operator-provided services.

```json
{
  "bindings": [
    {
      "name": "db",
      "serviceKind": "postgres",
      "labels": { "tier": "primary" },
      "required": true
    }
  ]
}
```

Core binding shape is documented in [Installer API](../reference/installer-api.md) and
[Platform Services](../reference/platform-services.md). Operator distributions may expose richer deploy facade commands
or dashboards.

To apply a changed source:

```bash
takosumi deploy inst_... --source "$APP_ROOT"
```

To roll back the current pointer:

```bash
takosumi rollback inst_... dep_...
```
