# Plain OpenTofu Capsule With a Service-side Lifecycle Action

This plain OpenTofu Capsule has no provider and no remote resources. Its Outputs
are ordinary return values. A Takosumi operator can attach a lifecycle action in
the service-side InstallConfig without changing the module:

```text
InstallConfig lifecycleActions[]
  -> explicit policy + RunnerProfile capability check
  -> Takosumi lifecycle activator
  -> restored source snapshot command
```

The relevant InstallConfig fragment is:

```json
{
  "lifecycleActions": [
    {
      "apiVersion": "takosumi.dev/v1alpha1",
      "kind": "command",
      "id": "activate",
      "phase": "post_apply",
      "executor": "runner",
      "command": ["bun", "-e", "console.log('activated')"],
      "workingDirectory": ".",
      "runnerCapability": "capsule.lifecycle.command.v1"
    }
  ],
  "policy": {
    "lifecycleActions": {
      "allowedExecutors": ["runner"],
      "allowedRunnerCapabilities": ["capsule.lifecycle.command.v1"]
    }
  }
}
```

The selected RunnerProfile must advertise the same capability. Takosumi treats
the command as an opaque argv array. Database migrations, artifact uploads, and
app initialization remain app/operator code. No repository manifest or Output
declares the action.

To prove the hosted/operator activator, set `executor` to `operator` in the
service-side action and allow that executor in policy. The OpenTofu shape stays
unchanged.

For failure evidence drills, replace the service-side action's argv with an
intentionally failing command. Do not add an OpenTofu variable or Output that
changes control-plane behavior.

Local check:

```bash
tofu init -input=false
tofu apply -auto-approve -input=false
tofu output -json
```
