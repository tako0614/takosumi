# Update, restore, or delete a service

Open a service (app) you added from **Workloads** in the dashboard. Its page has three tabs:
**Overview**, **Updates**, and **Settings**. This page walks through what you do after adding,
using the names on those screens.

Every action first creates a review of the changes (a plan) that shows how many resources will
be created, changed, and deleted. You then deploy it (apply). Creating the review alone changes
nothing.

## Update to a new version

When a new commit arrives on the Git ref the service tracks, its status becomes
**Update available** and **Update** appears at the top of its page.

- **Update** creates the review. If the change needs no approval, does not delete or replace an
  existing resource, and is not stopped by a policy or billing check, it continues to the
  deploy on its own. Otherwise it stops on the run screen.
- To look first, press **Review changes** under **Update service** on the **Updates** tab.
  Check the run screen, then press **Deploy**.

On the run screen, a change that needs approval shows **Approve this change**, and a change that
replaces or deletes an existing resource shows **Run destructive changes anyway**. Press either
only after checking what it does.

To switch to another branch, tag, or commit, open **Change version** under **Source version** on
the **Updates** tab, enter it in **Git ref**, and press **Review this version**. This creates a
review in the same way.

To change the settings you entered or the connected accounts, edit them under **Settings** and
**Connected accounts** on the **Settings** tab and press **Review changes**. Nothing is applied
on the settings screen itself.

### Update automatically

**Turn on automatic updates** under **Automatic updates** on the **Settings** tab creates one
update review for each new commit. Only a change with no deletes or replacements, no approval or
policy gate, and a known list of resource changes is deployed on its own. Anything else stops
on the run screen and is not deployed until someone checks it. It is off by default
([Sources and Capsules](../concepts/sources.md)).

## When something fails

When a review (plan) or a deploy (apply) fails, the run screen says "… failed." **Diagnostics** below it shows
the errors and warnings, and whether a connection needs checking.

1. Fix what **Diagnostics** points to: the **Connected accounts** on the **Settings** tab for a
   connection problem, or the Git repository for a module problem.
2. Press **Review changes again** on the run screen to create a new review.

Earlier runs are listed newest first under **Deploy history** in the user menu, which opens
from your initial at the top right. If the server itself does not respond or cannot reach the
runner, the people who run it should see [Troubleshooting](../self-host/troubleshooting.md).

## Go back to an earlier version (roll back)

**Update history** on the **Updates** tab lists each deployed version with its time and marks
the one in use as **Current**. Open **Restore a previous version** on an earlier entry and press
**Restore this state** to create a review that takes the service back to that version's source.
Nothing goes back until you check that review and deploy it.

Before you restore:

- The result is added to the history as a new version. The history is never erased, so you can
  undo the restore later.
- Only the state that Takosumi manages goes back. The contents of resources, such as database
  records or stored files, do not.
- The target commit must still exist in the repository; otherwise the review fails.
- Credentials are not part of a version, so the current connections are used.

See [State and outputs](../concepts/state-and-outputs.md) for details.

## Delete

Open **Delete this service** on the **Settings** tab. There are two ways, and both delete the
resources this service created in the cloud, along with the data inside them.

- **Schedule deletion** — **Schedule deletion** marks the service **Scheduled for deletion**. The
  service and its data stay for a grace period (7 days by default in the OSS build), and
  **Cancel deletion** undoes it until then. When the period ends, Takosumi tries to export the
  data and then deletes it ([Scheduled deletion](../concepts/scheduled-uninstall.md)).
- **Delete now** — **Review deletion** creates a review of the deletion. When you check it on
  the run screen and run it, the service is deleted at once and cannot be restored. A service
  that was never deployed is deleted right there.

If other services use this one, the services that would be affected are shown before you
delete it.
