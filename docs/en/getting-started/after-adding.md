# Update, restore, or delete a service

Open an app you added from the dashboard. The same page contains **Version**, **Settings**,
**History**, and **Uninstall** for the owner.

Updating, changing settings, and going back to an earlier version first create a plan.
Check what will be created, changed, or deleted and the estimated cost. Nothing is applied to
your cloud until you press **Allow and update** or **Allow and apply**. Reopening the page does
not give consent. Scheduling or cancelling an uninstall and switching automatic updates on or
off take effect through their own actions.

## Update to a new version

Press **Update** under **Version**. If no newer version has been detected, **Check for updates**
reads the latest content of the tracked branch or tag. Both stop at a review of the changes.
Check them, then press **Allow and update** to begin applying.

Changes with deletes or replacements have an extra confirmation checkbox. Plans that need
approval also require **Approve this change**. A plan held by approval, policy, or billing
conditions cannot be applied.

The Cloudflare build detects new Git commits through the hourly check or Source webhook.
The standard Bun and PostgreSQL build has neither the periodic check nor the webhook.
An app pinned to a commit does not acquire newer commits; a tag stays unchanged unless it is
moved to another commit. To switch to a different branch, tag, or commit, enter it in
**Tag, branch, or commit** under **Choose a version** and press **Review**. This also waits for
your permission before applying.

To change settings or connections, edit the values or **Connections it uses** under **Settings**
and press **Review**. The app keeps using its current settings until you review the changes and
press **Allow and apply**.

### Update automatically

Under **Version**, turn on **Update automatically when a newer version is found** in
**Automatic updates**. Takosumi creates one update plan for each new commit it detects.
Only a change with no deletes or replacements, no approval, policy, or billing gate, and a
known list of resource changes is applied automatically. Other changes wait for someone to
review them. A stopped or failed automatic update is not retried for the same commit.
Automatic updates are off by default ([Sources and Capsules](../concepts/sources.md)).
The manual **Update** button is separate from this setting.

## When something fails

The app page shows problems under **Needs attention**. Open **See reason and logs**, or
**Details** under **History**, to inspect the Run's result, reason, and logs.

1. For a connection problem, fix **Connections it uses** under **Settings**; for a module problem,
   fix the Git repository.
2. **Review again** creates a new plan to check before allowing it. If the action says
   **Review the installed version again**, it plans the installed version with the current
   settings instead of retrying the failed change.

If the apply response is lost, the page says the result could not be confirmed. Do not repeat
apply: read the Run result and current state through **History** first. Even a failed Run can
leave cloud changes or a new StateVersion. See [Run model](../concepts/run-model.md#when-a-run-fails).
If the server itself does not respond or cannot reach the runner, the people who run it should
also see [Troubleshooting](../self-host/troubleshooting.md).

## Go back to an earlier version (roll back)

**Go back to a previous version** under **Version** lists earlier applied versions. Press
**Go back to this version** on the one you want to create a plan using its source commit.
It takes effect only after you review it and press **Allow and apply**.

Before you restore:

- The result is added as a new StateVersion. History is never rewound or erased.
- This applies changes using the earlier version's source. It does not restore database rows
  or stored files. Deletes or replacements in the plan can lose the data inside resources.
- Settings and connections do not go back. The plan uses the current settings and connections.
- The target commit must still exist in the repository; otherwise the plan fails.

See [State and outputs](../concepts/state-and-outputs.md) for details.

## Delete

The owner can remove the app under **Uninstall**. If other apps use it, the affected links
are shown. Uninstall removes the resources this app created in the cloud and can lose the
data inside them.

- **With a grace period:** press **Uninstall** and confirm the dialog to schedule it. The OSS
  default is 7 days; the people who run Takosumi can change it. The app and data stay and billing
  continues during that period. **Cancel uninstall** cancels it. At the deadline, Takosumi tries
  to export the data before deleting. An export failure alone does not stop deletion, but it
  stops if the scheduler's authority, an unknown export result, or the deletion plan or apply
  cannot be confirmed safe ([Scheduled deletion](../concepts/scheduled-uninstall.md)).
- **To remove it immediately:** **Uninstall now** opens a deletion plan. No data is exported.
  Complete any required approval and confirmation checkbox, then press **Allow and uninstall**
  to begin deletion. This action appears when there is no grace period or the app is already
  scheduled for uninstall. It cannot be undone.

For an app that has never been applied, confirming **Uninstall** removes it right away.
If you do not know whether it created cloud resources, check the Run result and current state first.
