import type { ja } from "./ja.ts";

/**
 * English dictionary. The `Record<keyof typeof ja, string>` constraint makes
 * `ja.ts` the single source of truth for the key set — a missing or extra key
 * here is a type error, so the locales cannot drift.
 */
export const en: Record<keyof typeof ja, string> = {
  "installStore.title": "Add a service",
  "installStore.subtitle":
    "Find it, then add it. Any required setup appears here after you add.",
  "installStore.browseTitle": "Find a service",
  "installStore.browseHint":
    "Choose from a store or enter a public Git repository.",
  "installStore.manual": "Add from a Git repository",
  "installStore.back": "Choose again",
  "installStore.entryLoadTitle": "Review the available choices",
  "installStore.entryLoadHint":
    "Load the chooser document from the specified Git repository. This action creates the read-only Source and sync Run used to fetch it.",
  "installStore.entryLoad": "Load choices",
  "installStore.entryHint": "Choose one service to add.",
  "installStore.select": "Choose this",
  "installStore.configureHint":
    "Confirm the name and add. Repository analysis happens next.",
  "installStore.name": "Service name",
  "installStore.sourceDetails": "Source details",
  "installStore.sourceUrl": "Git URL",
  "installStore.sourceRef": "Ref (optional)",
  "installStore.sourcePath": "Module path",
  "installStore.sourceAuth": "Git connection",
  "installStore.publicSource": "Public repository",
  "installStore.add": "Add",
  "installStore.preparing": "Preparing your service",
  "installStore.preparingHint":
    "Checking the repository and gathering only the connections and changes it needs.",
  "installStore.compatibilityFailed":
    "This service cannot be added to the current environment.",
  "installStore.providerTitle": "A connection is needed",
  "installStore.destinationTitle": "Choose where this runs",
  "installStore.destinationHint":
    "More than one supported destination is available. Choose the destination for this service.",
  "installStore.providerHint":
    "Choose only the connections required by this service.",
  "installStore.chooseConnection": "Choose a connection",
  "installStore.destination": "Runs on",
  "installStore.connect": "Add a new connection",
  "installStore.continue": "Continue",
  "installStore.setupTitle": "Set up the service",
  "installStore.setupHint": "Enter only the values this service asks for.",
  "installStore.sourceBuildTitle": "Repository build steps",
  "installStore.sourceBuildHint":
    "Review these credential-free commands and produced paths before starting the Plan.",
  "installStore.sourceBuildCommand": "Command {index}",
  "installStore.sourceBuildWorkingDirectory": "Working directory",
  "installStore.sourceBuildSourceRoot": "Source root",
  "installStore.sourceBuildOutputs": "Produced paths",
  "installStore.setupInvalid": "The service setup definition is invalid.",
  "installStore.setupRequired": "Enter {label}.",
  "installStore.secretUnavailable": "Configure this secret as a connection.",
  "installStore.secretHint":
    "Secrets are never sent as variables from this form.",
  "installStore.reviewing": "Reviewing changes",
  "installStore.reviewingHint": "Checking the Plan before anything is applied.",
  "installStore.reviewTitle": "Review before install",
  "installStore.reviewHint": "These are the changes Takosumi will make.",
  "installStore.changes": "Changes",
  "installStore.createCount": "Create",
  "installStore.updateCount": "Change",
  "installStore.deleteCount": "Delete",
  "installStore.approve": "Approve Plan",
  "installStore.confirmTitle": "These changes need confirmation",
  "installStore.confirmHint":
    "The Plan includes deletion or another explicitly reviewed change.",
  "installStore.confirm": "I reviewed these changes",
  "installStore.install": "Install",
  "installStore.runDetails": "Technical details",
  "installStore.installing": "Installing",
  "installStore.installingHint":
    "Keep this page open while installation finishes.",
  "installStore.planBlocked": "This Plan cannot be applied",
  "installStore.planBlockedHint": "Review the policy or Plan details.",
  "installStore.readinessFailed":
    "The service readiness state could not be checked. Open the technical details for more information.",
  "installStore.activationFailed":
    "Service activation failed. Open the technical details for more information.",
  "installStore.finalizing": "Preparing the service",
  "installStore.finalizingHint":
    "Waiting for the service launch link to become available.",
  "installStore.launchNotReady":
    "The service was applied, but its launch link is not ready yet. Retry the check or open the service details.",
  "installStore.runFailed": "Service setup did not finish",
  "installStore.runFailedHint": "Open the technical details and try again.",
  "installStore.doneTitle": "Service added",
  "installStore.doneHint": "Open the service and start using it.",
  "installStore.open": "Open service",
  "installStore.chooseAnother": "Add another service",
  "installStore.invalidSource": "Enter a valid HTTPS Git URL.",
  "installStore.invalidName":
    "Use lowercase letters, numbers, and hyphens for the service name.",
  "installStore.planMissing": "The Plan response could not be identified.",
  "installStore.listingUnavailable":
    "This service is no longer available from the Store.",
  // --- common -------------------------------------------------------------
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.refresh": "Refresh",
  "common.create": "Create",
  "common.creating": "Creating…",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.delete": "Delete",
  "common.none": "None",
  "common.unknown": "Unknown",
  "common.dismiss": "Dismiss",
  "common.details": "Details",
  "common.fetchFailed": "Failed to load — {message}",
  "common.fetchFailedGeneric": "Couldn't load. Please try again in a moment.",
  "common.ok": "OK",
  "common.justNow": "just now",
  "common.minutesAgo": "{n}m ago",
  "common.hoursAgo": "{n}h ago",
  "common.daysAgo": "{n}d ago",
  "common.empty": "No data.",
  "common.loadMore": "Load more",
  "common.showingRecent": "Showing the latest {n}",

  // --- nav / shell ----------------------------------------------------------
  "nav.home": "Home",
  "nav.workloads": "Workloads",
  "nav.store": "Store",
  "nav.settings": "Settings",
  "nav.graph": "Dependencies",
  "nav.runs": "Deploy history",
  "nav.connections": "Connected accounts",
  "nav.billing": "Usage",
  "nav.activity": "History",
  "nav.primary": "Primary",
  "nav.notifications": "Notifications",
  "nav.workspaceSettings": "Workspace settings",
  "nav.account": "Account",
  "nav.docs": "Docs",
  "nav.backToTakos": "Back to Takos",
  "nav.deployContext": "Service hosting",
  "shell.skipToContent": "Skip to content",
  "shell.userMenu": "User menu",
  "shell.signOut": "Sign out",
  "shell.language": "Language",
  "shell.theme": "Appearance",
  "shell.notificationsAria": "Notifications ({n} needing attention)",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",

  // --- settings hub -----------------------------------------------------------
  "settings.title": "Settings",
  "settings.subtitle":
    "Account, usage, notifications, and the detailed management tools.",
  "settings.section.general": "General",
  "settings.section.advanced": "Advanced",
  "settings.account.title": "Account",
  "settings.account.desc": "Profile and sign-in details",
  "settings.billing.title": "Usage",
  "settings.billing.desc":
    "Your usage, and the cost breakdown your operator provides",
  "settings.notifications.title": "Notifications",
  "settings.notifications.desc": "Updates and items needing attention",
  "settings.manage.entry": "Management tools",
  "settings.manage.entryDesc":
    "Detailed screens for service internals, connections, and run history",
  "settings.manage.title": "Management tools",
  "settings.manage.subtitle":
    "Screens that work directly with hosting internals. You won't need these for everyday use.",
  "settings.manage.workloads": "Every deployed workload and its status",
  "settings.manage.connections": "Cloud account connections and keys",
  "settings.manage.runs": "Deploy and change execution records",
  "settings.manage.graph": "Dependencies between services",
  "settings.manage.activity": "Who changed what, and when",
  "settings.manage.workspace":
    "Access and sharing, keys, backups, and policy",
  "settings.manage.backups": "Create and restore restore points",
  "settings.manage.shares": "Manage values shared between services",

  // --- workspace switcher -------------------------------------------------------
  "workspace.label": "Your workspaces",
  "workspace.none": "No workspaces yet",
  "workspace.select": "Select a workspace for this view",
  "workspace.selectMessage":
    "Choose the Workspace where this work belongs.",
  "workspace.loading": "Loading workspaces…",
  "workspace.loadFailed": "Could not load workspaces — {message}",
  "workspace.settings": "Workspace settings",
  "workspace.switcherAria": "Switch workspace (current: {name})",
  "workspace.defaultName": "Personal",
  "workspace.start.aria": "Start a personal workspace",
  "workspace.start.kicker": "Personal workspace",
  "workspace.start.title": "Create a workspace for a purpose",
  "workspace.start.body":
    "Keep services, connected accounts, history, usage, and settings together in a private workspace.",
  "workspace.start.create": "New workspace",
  "workspace.start.creating": "Creating workspace…",
  "workspace.create.nameLabel": "Purpose or name",
  "workspace.create.namePlaceholder":
    "Personal, Work, Experiments, Client A",
  "workspace.create.nameRequired": "Enter a purpose or name.",
  "workspace.create.purposeHelp":
    "Private by default. You can share access later from advanced settings.",
  "workspace.create.failed": "Could not create the workspace — {message}",

  // --- auth -----------------------------------------------------------------
  "auth.signIn": "Sign in",
  "legal.policiesNav": "Operator policies",
  "auth.signInSub": "Sign in with a configured identity provider.",
  "auth.singleSignOn": "Single sign-on",
  "auth.continueWith": "Continue with {provider}",
  "auth.providerChecking": "Checking availability",
  "auth.providerUnavailable": "Currently unavailable",
  "auth.providerRetryNeeded": "Could not check availability",
  "auth.noProvidersTitle": "Sign-in is temporarily unavailable",
  "auth.noProvidersMessage":
    "No sign-in method is available right now. Please retry in a moment or contact support if this continues.",
  "auth.noProvidersMessageWithInstall":
    "These install details are preserved here. Retry after sign-in is available to continue.",
  "auth.providersLoadFailedTitle": "Could not check sign-in methods",
  "auth.providersLoadFailedMessage": "Check your connection and try again.",
  "auth.providersLoadFailedMessageWithInstall":
    "Check your connection and try again. These install details are still preserved on this screen.",
  "auth.retryProviderCheck": "Check again",
  "auth.sessionMaintenanceTitle": "Dashboard is temporarily unavailable",
  "auth.sessionMaintenanceBody":
    "The dashboard is undergoing maintenance. Please try again in a moment.",
  "auth.installContextAria": "Service to continue after sign-in",
  "auth.installContextKicker": "Continue adding",
  "auth.installContextTitle": "Continue after sign-in",
  "auth.installContextRef": "version {ref}",
  "auth.installContextDefaultRef": "default version",
  "auth.installContextRootPath": "main folder",
  "auth.termsPrefix": "By continuing, you agree to the ",
  "auth.termsOfService": "Terms of Service",
  "auth.and": " and ",
  "auth.privacyPolicy": "Privacy Policy",
  "auth.termsSuffix": ".",
  "auth.processing": "Signing you in…",
  "auth.failed": "Sign-in failed",
  "auth.backToSignIn": "Back to sign-in",
  "auth.retryableCallbackFailure":
    "Sign-in could not finish from this browser tab. Please try again.",
  "auth.retryableCallbackFailureWithDetail":
    "Sign-in could not finish. Please try again. Details: {message}",

  // --- 404 --------------------------------------------------------------
  "notFound.title": "Page not found",
  "notFound.message": "Check the URL — this page may have moved.",
  "notFound.goHome": "Go home",

  // --- errors / error boundary ------------------------------------------
  "error.generic": "Something went wrong. Please try again in a moment.",
  "errorBoundary.title": "Something went wrong",
  "errorBoundary.body":
    "An unexpected error stopped this page from loading. Please reload the page.",
  "errorBoundary.reload": "Reload",

  // --- status labels ----------------------------------------------------
  "status.capsule.pending": "Setting up",
  "status.capsule.needsAttention": "Needs attention",
  // `active` = the last apply succeeded and the state generation advanced; it
  // is NOT a verified-reachable signal, so say "Deployed", not "Running".
  "status.capsule.active": "Deployed",
  "status.capsule.stale": "Update available",
  "status.capsule.error": "Error",
  "status.capsule.disabled": "Disabled",
  "status.capsule.destroyed": "Deleted",
  "status.run.queued": "Queued",
  "status.run.running": "Running",
  "status.run.waiting_approval": "Waiting for approval",
  "status.run.succeeded": "Succeeded",
  "status.run.failed": "Failed",
  "status.run.cancelled": "Cancelled",
  "status.run.expired": "Expired",
  "status.run.ready_to_deploy": "Ready to run",
  "status.policy.pass": "Pass",
  "status.policy.warn": "Warnings",
  "status.policy.deny": "Denied",
  "status.stateVersion.current": "Current",
  "status.connection.pending": "Unverified",
  "status.connection.verified": "Verified",
  "status.connection.revoked": "Revoked",
  "status.connection.expired": "Expired",
  "status.connection.error": "Error",
  "status.providerConnection.ready": "Ready",
  "status.providerConnection.needs_setup": "Not verified yet",
  "status.providerConnection.expired": "Expired",
  "status.providerConnection.blocked": "Blocked",

  // --- run operation nouns (shared by run view / feeds) -------------------
  "op.plan": "Review",
  "op.apply": "Deploy",
  "op.destroy_plan": "Delete review",
  "op.destroy_apply": "Delete",
  "op.drift_check": "Drift check",
  "op.source_sync": "Fetch contents",
  "op.compatibility_check": "Pre-add check",
  "op.artifact": "Stage artifact",
  "op.backup": "Backup",
  "op.restore": "Restore",
  // Internal plan-operation nouns recorded on Activity metadata
  // (create/update/destroy) — mapped so feeds never fall back to "Operation".
  "op.create": "Add",
  "op.update": "Update",
  "op.generic": "Operation",

  // --- Service list (home) --------------------------------------------------
  "apps.title": "Apps",
  "apps.add": "Add service",
  "apps.addShort": "Add",
  "apps.sectionYours": "Your apps",
  "apps.manage": "Manage",
  "apps.manageAria": "Manage {name}",
  "apps.needsAttention": "Needs attention",
  "apps.openApp": "Open app",
  "apps.reviewChanges": "Review changes",
  "apps.start.aria": "First app",
  "apps.start.kicker": "No apps yet",
  "apps.start.titleEmpty": "Add your first app",
  "apps.start.bodyEmpty": "Choose an app or paste an install link.",
  "apps.start.optionStore": "Add an app",
  "apps.noLaunchable.kicker": "No openable apps yet",
  "apps.noLaunchable.title": "You have {count} service(s)",
  "apps.noLaunchable.body":
    "They're still starting up, or they have no screen to open. Check their status in the list.",
  "apps.noLaunchable.cta": "Open service list",
  "apps.listIncomplete":
    "Some apps could not be loaded, so this screen may be missing apps.",

  // --- Workload list (/workloads) -------------------------------------------
  "workloads.title": "Workloads",
  "workloads.subtitle":
    "Every deployed workload and its status. Open one for details.",
  "workloads.empty.title": "No workloads yet",
  "workloads.empty.body": "Services you add will appear here.",
  "workloads.deleteAria": "Delete workload {name}",
  "workloads.listIncomplete":
    "Some workloads could not be loaded, so this list may be incomplete.",

  // --- Service detail ------------------------------------------------------
  "app.capsuleSub": "Service",
  "app.tab.overview": "Overview",
  "app.tab.deploys": "Updates",
  "app.tab.settings": "Settings",
  "app.tab.danger": "Delete",
  "app.notFound": "Service not found",
  "app.backToList": "Back to list",
  "app.loadFailedTitle": "Couldn't load this service",
  "app.refreshFailed":
    "Couldn't fetch the latest state — showing the last loaded version.",
  "app.notFoundMessage": "It may have been deleted, or the link may be wrong.",
  "app.surfaces.title": "Public links",
  "app.surfaces.subtitle":
    "Screens this service declares and you are allowed to open appear here.",
  "app.surfaces.deletedSubtitle":
    "This service has been deleted. Its runtime links are no longer available.",
  "app.surfaces.activationPending":
    "You can open this address after service activation finishes.",
  "app.surfaces.activationFailed":
    "Service activation failed. Check recent updates for details.",
  "app.surfaces.empty":
    "Links appear after deployment and access setup finish.",
  "app.surfaces.loadError":
    "The public links could not be loaded. Reopen this page shortly.",
  "app.surfaces.none": "This service has no authorized public link.",
  "app.surfaces.defaultName": "Screen {n}",
  "app.surfaces.openAria": "Open {name} in a new tab",
  "app.surfaces.open": "Open public link",
  "app.deps.title": "Connected services",
  "app.deps.dependsOn": "Services this uses",
  "app.deps.usedBy": "Used by",
  "app.source.title": "Source",
  "app.source.name": "Name",
  "app.source.url": "Source URL",
  "app.source.refPath": "Version / folder",
  "app.source.loading": "Loading source info.",
  "app.source.unavailable": "Source info is unavailable.",
  "app.source.supportBody":
    "Source and reference details. Usually no change is needed.",
  "app.deploys.title": "Update history",
  "app.deploys.reviewTitle": "Update service",
  "app.deploys.reviewSubtitle":
    "Check available changes before deploying them.",
  "app.deploys.sourceVersionTitle": "Source version",
  "app.deploys.sourceVersionSubtitle":
    "Choose an exact Git commit before reviewing changes.",
  "app.deploys.sourceVersionCurrent": "Current version",
  "app.deploys.sourceVersionChange": "Change version",
  "app.deploys.sourceVersionInput": "Exact commit",
  "app.deploys.sourceVersionHint":
    "Enter a 40-character Git commit. Branches and tags are not accepted.",
  "app.deploys.sourceVersionApply": "Set version",
  "app.deploys.sourceVersionUnavailable":
    "The existing Source could not be loaded.",
  "app.deploys.empty": "No deploys yet.",
  "app.deploys.restore": "Restore this state",
  "app.deploys.restoreDisclosure": "Restore a previous version",
  "app.deploys.advancedActions": "Extra actions",
  "app.deploys.advancedActionsBody":
    "Use these only when you need a restore point or backup.",
  "app.deploys.backup": "Create backup",
  "app.deploys.backupCreated": "Backup created.",
  "app.deploys.backupSupportRef": "Backup ID",
  "app.deploys.inventoryTitle": "Deployed resources",
  "app.deploys.inventoryRecordedNote":
    "Recorded in the current applied state; this is not live health.",
  "app.deploys.inventoryLoadError":
    "The recorded resource inventory could not be loaded.",
  "app.deploys.inventoryLegacyUnavailable":
    "This older applied state has no resource inventory record.",
  "app.deploys.inventoryGeneration": "State generation",
  "app.deploys.inventoryRecordedAt": "Recorded",
  "app.deploys.inventoryStateVersion": "State version",
  "app.deploys.inventoryApplyRun": "Apply run",
  "app.deploys.inventoryPlanRun": "Plan run",
  "app.deploys.inventoryEmpty": "No deployed resources were recorded.",
  "app.recentActivity.title": "Recent updates",
  "app.recentActivity.open": "Details",
  "app.recentActivity.releaseActivation": "Service activation",
  "app.bindings.title": "Connected accounts",
  "app.bindings.subtitle":
    "External service access this service can use while publishing. Usually no change is needed.",
  "app.bindings.none": "No connected account is linked.",
  "app.bindings.editAdvanced": "Change connected account mapping",
  "app.bindings.add": "Add connected account",
  "app.bindings.providerPlaceholder": "Connection target",
  "app.bindings.providerLabel": "Connection target",
  "app.bindings.moduleLocalNamePlaceholder": "Module provider name",
  "app.bindings.moduleLocalNameLabel": "Module provider name",
  "app.bindings.childAliasPlaceholder": "Child alias (optional)",
  "app.bindings.childAliasLabel": "Child provider alias",
  "app.bindings.rootAliasPlaceholder": "Root alias (optional)",
  "app.bindings.rootAliasLabel": "Root provider alias",
  "app.bindings.selectConnection": "Select connected account",
  "app.bindings.technicalTarget": "Connection target details",
  "app.bindings.remove": "Remove",
  "app.bindings.errorProvider": "Enter the connection target for row {index}.",
  "app.bindings.errorConnection":
    "Select a ready connected account for {provider}.",
  "app.config.title": "Settings",
  "app.config.subtitle":
    "Change the public name, URL, first sign-in value, and service variables. Saved values apply on the next deploy review.",
  "app.config.publicUrl": "Public URL",
  "app.config.subdomain": "Public subdomain",
  "app.config.oidc": "Automatic sign-in",
  "app.config.oidcOn": "Enabled",
  "app.config.updatedAt": "Updated",
  "app.config.empty": "There are no editable settings.",
  "app.config.notReady": "Settings haven\u2019t loaded yet. Reload the page.",
  "app.config.advanced": "Other settings",
  "app.config.addVariable": "Add setting",
  "app.config.name": "Name",
  "app.config.value": "Value",
  "app.config.enabled": "Enabled",
  "app.config.secretHint":
    "Already saved. Enter a new value only to change it.",
  "app.config.reset": "Reset",
  "app.config.remove": "Remove",
  "app.config.undoReset": "Undo",
  "app.config.resetAria": "Reset {name}",
  "app.config.removeAria": "Remove setting {name}",
  "app.config.undoResetAria": "Undo reset of {name}",
  "app.config.defaultBadge": "Default value",
  "app.config.resetPendingHint": "Reverts to the default when you save.",
  "app.config.customName": "CUSTOM_ENV",
  "app.config.errorNameRequired": "Enter a setting name.",
  "app.config.errorNameInvalid": "{name} cannot contain spaces.",
  "app.config.errorNameDuplicate": "{name} is duplicated.",
  "app.config.errorNumber": "{name} must be a number.",
  "app.config.errorJson": "{name} must be valid JSON.",
  "app.interfaces.title": "What this app exposes (advanced)",
  "app.interfaces.subtitle":
    "Declare the surfaces other services and apps can use. Changes apply on the next deploy review.",
  "app.interfaces.editorLabel": "Interface blueprints (JSON)",
  "app.interfaces.editorHint":
    "Use an array. Each declaration explicitly provides key, name, and spec. Put dynamic mappings under spec.inputs with a literal, capsule_output, or resource_output source. Do not put secrets here.",
  "app.interfaces.notReady":
    "These declarations haven\u2019t loaded yet. Reload the page.",
  "app.interfaces.errorJson": "Enter valid JSON.",
  "app.interfaces.errorArray":
    "Interface blueprint JSON must be an array. Use [] to remove all declarations.",
  "app.settings.openCta": "Open settings",
  "app.settings.supportDetails": "Reference info",
  "app.settings.leaveConfirm.title": "Discard your changes?",
  "app.settings.leaveConfirm.body":
    "You have unsaved settings changes. Leaving will discard them.",
  "app.settings.leaveConfirm.confirm": "Discard and leave",
  "app.usage.title": "Estimated cost (total)",
  "app.usage.body":
    "Rated cost for this service; unrated usage is shown separately.",
  "app.usage.subCent": "< $0.01",
  "app.usage.unrated": "Unrated",
  "app.usage.unratedCount": "Unrated usage records: {n}",
  "app.config.savedNeedsDeploy": "Saved. Deploy to apply the change.",
  "app.config.deployChanges": "Deploy changes",
  "app.updateNow": "Update",
  "app.autoUpdate.title": "Automatic updates",
  "app.autoUpdate.body":
    "Update automatically when a new version arrives. Changes that rebuild or remove resources always wait for your review.",
  "app.autoUpdate.enable": "Turn on automatic updates",
  "app.autoUpdate.disable": "Turn off automatic updates",
  "app.danger.destroyTitle": "Delete this service",
  "app.danger.destroyBody":
    "Deleting {name} first creates a delete review so you can inspect what will be removed, then you run it. Once run, the resources are removed and cannot be restored.",
  "app.danger.destroyConfirmTitle": "Delete this service?",
  "app.danger.destroyConfirmMessage":
    "This deletes {name}. If it has never been deployed it is removed immediately and cannot be recovered.",
  "app.danger.destroyCta": "Review deletion",
  "app.setupIncomplete.body":
    "Setup didn't finish. Retry from the update review, or delete this service and start over.",
  "app.setupIncomplete.review": "Open updates",
  "app.setupIncomplete.delete": "Delete options",

  // --- run view --------------------------------------------------------------
  "run.title.plan": "Review changes",
  "run.title.apply": "Deploy",
  "run.title.destroy": "Delete",
  "run.title.other": "Operation",
  "run.notFoundTitle": "This run was not found",
  "run.notFoundMessage": "It may have been deleted, or the link may be wrong.",
  "run.loadFailedTitle": "Couldn't load this run",
  "run.refreshFailed":
    "Couldn't fetch the latest status — showing the last loaded state.",
  "run.summary.planning": "Reviewing the changes…",
  "run.summary.queued": "Waiting to run…",
  "run.summary.waitingApproval":
    "This change needs approval before it can run. Review it and approve.",
  "run.summary.ready": "“{name}” is ready to deploy.",
  "run.summary.readyGeneric": "This service is ready to deploy.",
  "run.summary.readyChanges":
    "Create {create} / Update {update} / Delete {delete}",
  "run.summary.destroyReady":
    "“{name}” is ready to be deleted. This cannot be undone once run.",
  "run.summary.destroyReadyGeneric":
    "This service is ready to be deleted. This cannot be undone once run.",
  "run.summary.applied": "Deploy started. It will take a moment to settle.",
  "run.summary.alreadyApplied":
    "This change's deploy has already been run. See Activity for the result.",
  "run.summary.applying": "Deploying…",
  "run.summary.finishing": "Finishing the deployment…",
  "run.summary.checkingDeploy": "Checking deploy readiness…",
  "run.summary.activationPending": "Finishing service activation…",
  "run.summary.activationFailed":
    "Service activation failed after the infrastructure deploy completed.",
  "run.summary.readinessUnavailable": "Service readiness could not be checked.",
  "run.summary.readinessUnavailableHint":
    "Takosumi will retry the readiness read. The apply is not reported as ready until the check succeeds.",
  "run.summary.applySucceeded": "Deploy complete.",
  "run.summary.removing": "Removing…",
  "run.summary.removed": "Removal complete.",
  "run.summary.failed": "{operation} failed.",
  "controlError.stateGenerationMismatch":
    "Another change ran first. Review the changes again before deploying.",
  "controlError.dependencySnapshotStale":
    "A connected service was updated first. Review the changes again.",
  "controlError.dependencyUnavailable":
    "Values from a connected service aren't available right now. Try again in a moment.",
  "controlError.sourceChanged":
    "The source contents changed. Review the changes again.",
  "controlError.sourceRevisionMismatch":
    "The source identity or exact version changed. Review the current service again.",
  "controlError.invalidSourceRevision":
    "Enter an exact 40-character Git commit before reviewing changes.",
  "controlError.compatibilityStale":
    "The check result is out of date. Check again.",
  "controlError.runnerUnavailable":
    "The run environment isn't available right now. Try again in a moment.",
  "controlError.slotLimitReached":
    "You've reached your limit. Remove a service you no longer need, or contact your operator.",
  "controlError.capsuleNotFound":
    "That service could not be found. It may have been deleted.",
  "controlError.configNotFound":
    "Setup for this service could not be found. Add it again.",
  "controlError.shareRevoked": "This share has been revoked.",
  "runError.sourceSyncFailed":
    "The service contents could not be fetched. Check the link and version, then try again.",
  "runError.sourceRefNotFound":
    "The selected version was not found. Check the version, then try again.",
  "runError.stateGenerationMismatch":
    "Another change ran first. Review the changes again before deploying.",
  "runError.planFailed":
    "The change review failed. Check the details, then try again.",
  "runError.applyFailed":
    "The deploy failed. Check the details, then try again.",
  "runError.runFailed": "The run failed. Please try again.",
  "runError.backupFailed":
    "The restore point could not be created. Please try again.",
  "run.summary.failedHint":
    "Check the diagnostics and logs below for the cause.",
  "run.summary.hostnameSlotLimit": "No short URL slots are available.",
  "run.summary.hostnameSlotLimitHint":
    "Use a standard URL or release an existing short URL, then run again.",
  "run.summary.connectionVerificationRequired":
    "Connected account check is needed.",
  "run.summary.connectionVerificationHint":
    "The connected account may have changed since this run was created. Review the changes again, then deploy.",
  "run.summary.connectionSetupRequired": "Connected account setup is needed.",
  "run.summary.connectionSetupHint":
    "Choose or finish setting up the account connection, then run the deploy again.",
  "run.summary.connectionChanged": "Review the connected account again.",
  "run.summary.connectionChangedHint":
    "The connected account changed after this run was reviewed. Review the current changes again before deploying.",
  "run.summary.credentialServiceIssue": "Access preparation did not finish.",
  "run.summary.credentialServiceHint":
    "Takosumi could not prepare access to the connected account. Try again, or contact support if it continues.",
  "run.summary.blocked": "Blocked by policy.",
  "run.summary.blockedHint":
    "Review the policy settings, or re-check the changes after fixing them.",
  "run.summary.driftDone": "Drift check complete.",
  "run.summary.cancelled": "This run was cancelled.",
  "run.summary.expired": "This review has expired.",
  "run.summary.expiredHint": "Review the changes again, then deploy.",
  "run.summary.compatDone": "The pre-add check finished.",
  "run.summary.compatRunning": "Checking the contents…",
  "run.summary.syncDone": "The contents were fetched.",
  "run.summary.syncRunning": "Fetching the contents…",
  "run.summary.fallback": "Status: {status}",
  "run.approve": "Approve this change",
  "run.approving": "Approving…",
  "run.deploy": "Deploy",
  "run.deploying": "Deploying…",
  "run.deployBlocked": "Deploy blocked",
  "run.retryPlan": "Review changes again",
  "run.backToApp": "Back to service",
  "run.appHandoff.open": "Open in {app}",
  "run.destructiveWarning":
    "This change replaces or deletes existing resources. Running it may lose data.",
  "run.destructiveConfirm": "Run destructive changes anyway",
  "run.stopGoBack": "Go back",
  "run.cancel": "Cancel this run",
  "run.approveConfirm.restoreTitle": "Restore from this backup?",
  "run.approveConfirm.restoreMessage":
    "This replaces {name} with the contents of the selected backup. The current state is overwritten and cannot be recovered.",
  "run.approveConfirm.restoreMessageGeneric":
    "This replaces the service with the contents of the selected backup. The current state is overwritten and cannot be recovered.",
  "run.approveConfirm.destroyTitle": "Run this deletion?",
  "run.approveConfirm.destroyMessage":
    "This deletes {name}'s resources. It cannot be undone.",
  "run.approveConfirm.destroyMessageGeneric":
    "This deletes the target resources. It cannot be undone.",
  "run.cancelConfirm.title": "Cancel this run?",
  "run.cancelConfirm.message":
    "This stops the {operation} for “{name}” before it finishes.",
  "run.cancelConfirm.messageGeneric":
    "This stops the {operation} before it finishes.",
  "run.cancelConfirm.cta": "Cancel run",
  "run.cancelConfirm.keep": "Keep running",
  "run.cost.required": "Estimated cost: ~{n}",
  "run.cost.unrated": "Usage measured; no price policy is configured.",
  "run.cost.capacityBlocked": "This workspace cannot run this action.",
  "run.cost.billingCta": "Open billing",
  "run.cost.operatorHelp":
    "An owner can review this workspace's usage and limits to enable it.",
  "run.cost.quotaCta": "Review usage",
  "run.changes.title": "What will change",
  "run.changes.titleDone": "What changed",
  "run.changes.noRecord": "No record of the changes is available",
  "run.changes.create": "Create",
  "run.changes.update": "Update",
  "run.changes.delete": "Delete",
  "run.resources.kicker": "Review",
  "run.resources.title": "Planned changes",
  "run.resources.count": "Changes: {n}",
  "run.resources.more": "Additional changes: {n}",
  "run.resources.actionCreate": "Create",
  "run.resources.actionUpdate": "Update",
  "run.resources.actionDelete": "Delete",
  "run.resources.actionReplace": "Replace",
  "run.resources.identifiers": "Reference IDs",
  "run.resources.address": "Address",
  "run.resources.type": "Type",
  "run.resources.scope": "Scope",
  "run.details.title": "Reference info",
  "run.details.runId": "Run ID",
  "run.details.type": "Type",
  "run.details.policy": "Safety check",
  "run.details.capsule": "Service",
  "run.details.sourceSnapshot": "Source version",
  "run.details.dependencySnapshot": "Pinned connected inputs",
  "run.details.baseGeneration": "Previous state",
  "run.details.planDigest": "Change verification ID",
  "run.details.created": "Created",
  "run.details.started": "Started",
  "run.details.finished": "Finished",
  "run.details.error": "Error",
  "run.details.debug": "Identifiers",
  "run.inputs.title": "Values from connected services",
  "run.inputs.empty": "No values were received from connected services.",
  "run.connections.setupCta": "Set up the connection",
  "run.connections.title": "Connected accounts",
  "run.connections.reviewTitle": "Connected account review needed",
  "run.connections.reviewBody":
    "One or more connected accounts need attention before this can continue. Private values are not shown.",
  "run.connections.provider": "Connection target",
  "run.connections.connection": "Access",
  "run.connections.status": "Status",
  "run.connections.statusResolved": "Ready",
  "run.connections.statusMissing": "Access needed",
  "run.connections.statusBlocked": "Blocked by policy",
  "run.connections.empty": "No connected account review info.",
  "run.diagnostics.title": "Diagnostics",
  "run.diag.severity.error": "Error",
  "run.diag.severity.warning": "Warning",
  "run.diag.severity.info": "Info",
  "run.diagnostics.failed":
    "This did not finish. Open details only when you need troubleshooting information.",
  "run.diagnostics.hostnameSlotLimitShort": "No short URL slots are available.",
  "run.diagnostics.hostnameSlotLimitDetail":
    "Use a standard URL or release an existing short URL, then run again.",
  "run.diagnostics.connectionVerificationRequired":
    "This run stopped while preparing access to a connected account. If the connection is now ready, review the changes again before deploying.",
  "run.diagnostics.connectionVerificationShort":
    "Connected account access was not ready.",
  "run.diagnostics.connectionVerificationDetail":
    "Review the changes again so Takosumi can use the current connected account state.",
  "run.diagnostics.connectionSetupRequired":
    "This run needs a connected account before Takosumi can deploy it.",
  "run.diagnostics.connectionSetupShort":
    "An account connection is not configured for this deploy.",
  "run.diagnostics.connectionSetupDetail":
    "Open connections, choose the required account, then run the deploy again.",
  "run.diagnostics.connectionChanged":
    "The connected account changed after this run was reviewed.",
  "run.diagnostics.connectionChangedShort":
    "The reviewed account connection is no longer current.",
  "run.diagnostics.connectionChangedDetail":
    "Create a new review so the deploy uses the current connected account state.",
  "run.diagnostics.credentialServiceIssue":
    "Takosumi could not prepare temporary access for this run.",
  "run.diagnostics.credentialServiceShort":
    "Temporary access could not be prepared.",
  "run.diagnostics.credentialServiceDetail":
    "Try again. If this keeps happening, contact support.",
  "run.audit.title": "Activity record",
  "run.audit.empty": "No activity records.",
  "run.audit.detail": "Record detail",

  // --- run history --------------------------------------------------------------
  "runList.title": "Deploy history",
  "runList.subtitle": "Recent reviews, approvals, and deploys, newest first.",
  "runList.open": "Details",
  "runList.review": "Review",
  "runList.openAria": "Open details: {title}",
  "runList.reviewAria": "Review: {title}",
  "runList.empty.title": "No updates yet",
  "runList.empty.message":
    "After you add a service and review a change, update history appears here.",
  "runList.applied": "Deploy",
  "runList.destroyed": "Delete",
  "runList.failed": "{operation} failed",
  "runList.namesUnavailable":
    "Couldn't load service names — showing updates without them.",

  // --- add flow (/new) -------------------------------------------------------
  "new.git.defaultRef": "Git default branch",
  "new.compat.ready": "Can be added as is",
  "new.compat.patch": "Needs manual changes",
  "new.compat.unsupported": "Cannot be added right now",
  "new.compat.summary.providerCredentials":
    "Remove {provider} private values from the source before adding this.",
  "new.compat.summary.installUxInvalid":
    "This app version's setup declaration needs to be fixed by its publisher.",
  "new.compat.summary.reviewRequired":
    "An item needs review before this can be added.",
  "new.compat.issue.providerCredentials.message":
    "{provider} private values are written in the source.",
  "new.compat.issue.providerCredentials.detail":
    "Do not keep API tokens or account IDs in code. Remove those values, then connect {provider} access so Takosumi can pass them only while deploying.",
  "new.compat.issue.installUxInvalid.message":
    "The app's setup declaration does not match the selected version.",
  "new.compat.issue.installUxInvalid.detail":
    "Choose another version or ask the app publisher to update .well-known/takosumi.json. Takosumi will not replace it with raw module variables.",
  "new.compat.issue.providerPreserved.message":
    "The repository's non-secret {provider} configuration will be preserved.",
  "new.compat.issue.backendIsolated.message":
    "The repository backend configuration is preserved while Takosumi isolates the Run state boundary.",
  "new.compat.issue.lockfile.message":
    "Pinned connection target information is included. After private values are removed, the pinned targets will be reviewed during add.",
  "new.compat.issue.reviewRequired.message":
    "An item needs review before this can be added.",
  "new.error.sourceRefNotFound":
    "The selected version “{ref}” was not found. Check that the link offers this version.",
  "new.error.sourceFetchFailed":
    "The service contents could not be fetched. Check the link, version, folder, or private link access. Details: {message}",
  "new.error.sourceFetchFailedUnknown": "No detailed cause was returned.",
  "new.error.generic":
    "The service could not be added. Check the details and try again.",
  "new.error.genericWithDetails":
    "The service could not be added. Details: {message}",
  "new.error.invalidHostname":
    "This public name is too long or has characters that cannot be used. Try a shorter name.",
  "new.error.connectionRequired":
    "Publishing this service needs a connected cloud account. Set up the connection, then try again.",
  "new.error.appHostnameUnavailable":
    "That public URL name is already in use. Choose another name and try again.",
  "new.error.managedHostnameSlotLimit":
    "No short URL slots are available. Use a standard URL or release an existing short URL.",
  "new.error.alreadyExistsGeneric":
    "This service is already added. Open the existing service instead of creating another one.",
  "workspaceSettings.title": "Settings",
  "workspaceSettings.tabsLabel": "Settings sections",
  "workspaceSettings.subtitle":
    "Review the workspace name, connected accounts, usage, and optional access controls.",
  "workspaceSettings.tab.general": "General",
  "workspaceSettings.tab.members": "Access & sharing",
  "workspaceSettings.tab.connections": "Connections",
  "workspaceSettings.tab.billing": "Usage",
  "workspaceSettings.tab.usageQuota": "Usage",
  "workspaceSettings.tab.backups": "Backups",
  "workspaceSettings.tab.shares": "Shared values",
  "workspaceSettings.general.displayName": "Display name",
  "workspaceSettings.general.handle": "Handle",
  "workspaceSettings.general.type": "Type",
  "workspaceSettings.general.owner": "Owner",
  "workspaceSettings.general.updated": "Updated",
  "workspaceSettings.general.advancedDetails": "Advanced details",
  "workspaceSettings.general.saved": "Settings saved.",
  "workspaceSettings.general.archive": "Hide workspace",
  "workspaceSettings.general.archiveConfirm":
    "This only hides the workspace from the normal switcher. Running services, history, usage, and stored data are not stopped or deleted. You can restore it any time from “Archived” below.",
  "workspaceSettings.general.archivedNamed":
    "Hidden “{name}” from the normal switcher.",
  "workspaceSettings.general.archivedHint":
    "This only changes visibility; services and usage continue as before. Restore it from the archived list below, or move to another workspace with the workspace switcher.",
  "workspaceSettings.general.notFound":
    "This workspace was not found. Switch workspaces, or restore one below.",
  "workspaceSettings.general.archivedTitle": "Archived workspaces",
  "workspaceSettings.general.unarchive": "Restore",
  "workspaceSettings.general.archiveLastError":
    "You cannot hide the last workspace.",
  "workspaceSettings.general.nameRequired": "Enter a display name.",

  // --- members ---------------------------------------------------------------
  "members.role.owner": "Owner",
  "members.role.admin": "Admin",
  "members.role.member": "Member",
  "members.role.viewer": "Viewer",
  "members.status.active": "Active",
  "members.status.invited": "Invited",
  "members.status.suspended": "Suspended",
  "members.invite.title": "Share access",
  "members.invite.subtitle":
    "Enter the email for someone who has already signed in. They get access immediately — no email is sent.",
  "members.invite.email": "Email",
  "members.invite.role": "Role",
  "members.invite.cta": "Add",
  "members.invite.notFound":
    "No Takosumi account was found for that email. Ask them to sign in once first.",
  "members.invite.emailRequired": "Enter an email address.",
  "members.invite.success": "Added {email}. They have access now.",
  "members.col.member": "Member",
  "members.col.roles": "Roles",
  "members.col.status": "Status",
  "members.col.actions": "Actions",
  "members.you": "you",
  "members.changeRole": "Change role",
  "members.roleSelectLabel": "Role for {name}",
  "members.roleChangeConfirmTitle": "Change role",
  "members.roleChangeConfirmMessage": "Change the role of {name} to “{role}”?",
  "members.lastOwnerDemote":
    "The last owner cannot be demoted. Appoint another owner first.",
  "members.lastOwnerRemove":
    "The last owner cannot be removed. Appoint another owner first.",
  "members.remove": "Remove",
  "members.removeSelf": "Remove yourself",
  "members.removeSelfConfirm":
    "This removes you from the workspace. You will lose access and cannot restore it yourself.",
  "members.removeConfirm": "Remove this member? ({account})",
  "members.empty": "This workspace has no members yet.",
  "members.viewerNote":
    "Only owners and admins can invite, change roles, or remove members.",

  // --- connections -------------------------------------------------------------
  "conn.subtitle":
    "Connect an external provider with your own credentials. Availability follows the operator provider policy, runner capability, and Run approval rules.",
  "conn.providerConnections.title": "Connected accounts",
  "conn.expiresAt": "Expires: {date}",
  "conn.oauth.connected": "Provider connection saved.",
  "conn.oauth.failed": "Connection failed. Please try again.",
  "conn.oauth.error.missingCode":
    "The authorization response was incomplete. Please try again.",
  "conn.oauth.error.forbidden":
    "You do not have permission to connect this workspace.",
  "conn.oauth.error.oauthFailed":
    "Authentication with the provider failed. Please wait a moment and try again.",
  "conn.oauth.errorCode": "Error code: {code}",
  "conn.return.title": "Continue adding {name}",
  "conn.return.subtitle":
    "Save the connected account, then return to finish adding the service.",
  "conn.return.cta": "Back to add service",
  "conn.saved.message": "Saved {name}.",
  "conn.saved.needsTest":
    "Saved {name}. Verify the connection before returning to add the service.",
  "conn.saved.testCta": "Verify connection",
  "conn.saved.returnCta": "Back to add",
  "conn.add.provider": "Connection",
  "conn.add.genericEnvOption": "Other connection (advanced)",
  "conn.add.title": "Connect account",
  "conn.add.open": "Connect account",
  "conn.add.close": "Close",
  "conn.add.optionalSettings": "Name this connection",
  "conn.add.displayName": "Connection name",
  "conn.add.displayNamePlaceholder": "Optional label",
  "conn.guided.openProvider": "Open {provider} access page",
  "conn.guided.instructions": "Show steps",
  "conn.byok.title": "Connect an external provider with your own key",
  "conn.byok.body":
    "Enter the provider source and the environment variables it requires. The connection remains subject to provider policy, runner capability, and Run approval.",
  "conn.byok.noBillingNote":
    "Any Takosumi charge is shown during preview. Charges from the external provider are billed separately by that provider.",
  "conn.byok.usePreset": "Use an installed recipe instead",
  "conn.register": "Save connection",
  "conn.registering": "Saving…",
  "conn.genericEnv.providerName": "Provider source",
  "conn.genericEnv.providerPlaceholder": "examplecorp/example",
  "conn.genericEnv.envName": "Env name",
  "conn.genericEnv.envNamePlaceholder": "EXAMPLE_API_TOKEN",
  "conn.genericEnv.value": "Value",
  "conn.genericEnv.valuePlaceholder": "Paste the value",
  "conn.genericEnv.addRow": "Add value",
  "conn.genericEnv.providerRequired": "Enter a provider source.",
  "conn.genericEnv.nameRequired": "Rows with a value need a value name.",
  "conn.genericEnv.invalidName":
    "“{name}” isn’t a valid env name. Use an uppercase env name like EXAMPLE_API_TOKEN.",
  "conn.genericEnv.reservedName":
    "“{name}” is reserved for the runner. Use a provider-specific env name.",
  "conn.genericEnv.duplicateName": "“{name}” is already added.",
  "conn.genericEnv.oneRequired": "Enter at least one value.",
  "conn.error.invalidProvider": "Invalid connection target.",
  "conn.error.fieldRequired": "{field} is required.",
  "conn.empty.title": "Connect an external provider with your own key",
  "conn.empty.message":
    "Connect your own credentials to use an external provider within the installed policy, runner, approval, and billing rules.",
  "conn.test": "Check access",
  "conn.testing": "Checking…",
  "conn.test.notReady": "The account is not ready yet (status: {status}).",
  "conn.remove.confirmTitle": "Delete connected account",
  "conn.remove.confirmMessage":
    "Really delete {name}? Its saved access values are deleted too. This cannot be undone.",
  "conn.remove.bindingWarning":
    "Services that use this connection will fail to deploy.",

  // --- backups -----------------------------------------------------------------
  "backups.subtitle":
    "Create and inspect partial control exports. Import and restore are not supported.",
  "backups.create": "Create backup",
  "backups.creating": "Creating a backup.",
  "backups.col.createdAt": "Created",
  "backups.col.contents": "Contents",
  "backups.controlExport": "Partial control export",
  "backups.empty.title": "No backups yet",
  "backups.empty.message": "Create this workspace's first backup.",

  // --- shared values -------------------------------------------------------------
  "shares.subtitle": "Manage public values another workspace can use.",
  "shares.create.title": "Create a share",
  "shares.create.toWorkspace": "Target workspace",
  "shares.create.producer": "Source service",
  "shares.create.workspacesError": "Couldn't load workspaces.",
  "shares.create.workspacesEmpty":
    "No other workspaces are available to share with.",
  "shares.create.capsulesError": "Couldn't load services.",
  "shares.create.capsulesEmpty": "No services are available to share from.",
  "shares.create.selectPlaceholder": "Select",
  "shares.create.outputs": "Shared values",
  "shares.create.addOutput": "Add shared value",
  "shares.create.removeOutput": "Remove",
  "shares.create.outputName": "Value name",
  "shares.create.outputAlias": "Display as",
  "shares.create.sensitiveValue": "Sensitive value",
  "shares.create.sensitiveReason": "Reason for sharing sensitive values",
  "shares.create.sensitivePlaceholder": "Why this value needs to be shared",
  "shares.create.cta": "Create share",
  "shares.error.outputsRequired": "Enter at least one value name to share.",
  "shares.error.reasonRequired": "Enter a reason for sharing sensitive values.",
  "shares.error.toWorkspaceRequired": "Select a target workspace.",
  "shares.error.producerRequired": "Select a source service.",
  "shares.col.direction": "Direction",
  "shares.col.capsule": "Service",
  "shares.col.outputs": "Shared values",
  "shares.col.status": "Status",
  "shares.approve": "Approve",
  "shares.revoke": "Revoke",
  "shares.revokeConfirmTitle": "Revoke share",
  "shares.revokeConfirmMessage":
    "Revoke the share to {target}? The receiving workspace loses access to these values.",
  "shares.status.active": "Active",
  "shares.status.pending": "Pending approval",
  "shares.status.revoked": "Revoked",
  "shares.list.title": "Shares",
  "shares.empty": "No shares yet.",

  // --- notifications -------------------------------------------------------------
  "notif.markAllRead": "Mark all as read",
  "notif.title": "Notifications",
  "notif.subtitle":
    "Adds, deploys, approvals, failures — what happened most recently.",
  "notif.empty.title": "No notifications yet",
  "notif.empty.message": "Events appear here when you add or deploy services.",
  "notif.attention": "Events needing attention: {n}",
  "notif.badge.attention": "Attention",
  "notif.supportSummary": "Reference info",
  "notif.viewRaw": "Open history →",
  "notif.event.installCreated": "Added service “{name}”",
  "notif.event.installCreatedEnv": "Environment: {env}",
  "notif.event.planReady": "{operation} is ready",
  "notif.event.planReadyNamed": "{operation} for “{name}” is ready",
  "notif.event.planReadyDetail": "Review the contents and approve",
  "notif.event.planBlockedDetail": "Approval is blocked by policy",
  "notif.event.approved": "Approved {operation}",
  "notif.event.approvedNamed": "Approved {operation} for “{name}”",
  "notif.event.applied": "Deployed service changes",
  "notif.event.appliedNamed": "Deployed changes to “{name}”",
  "notif.event.appliedDetail": "Public values updated: {n}",
  "notif.event.destroyed": "Deleted a service",
  "notif.event.destroyedNamed": "Deleted “{name}”",
  "notif.event.failed": "{operation} failed",
  "notif.event.failedNamed": "{operation} for “{name}” failed",
  "notif.event.drift": "A service's real state differs from the saved record",
  "notif.event.driftNamed":
    "The real state of “{name}” differs from the saved record",
  "notif.event.driftDetail":
    "The live state may have drifted from its settings",
  "notif.event.stale":
    "A dependency changed — an update is available for this service",
  "notif.event.staleNamed":
    "A dependency changed — an update is available for “{name}”",
  "notif.event.staleDetail": "Updated by: {producer}",
  "notif.event.connCreated": "Added connected account “{provider}”",
  "notif.event.connCreatedGeneric": "Added connected account",
  "notif.event.connRevoked": "Connected account “{provider}” was revoked",
  "notif.event.connRevokedGeneric": "Connected account was revoked",
  "notif.event.backupCreated": "Created a backup",
  "notif.event.depCreated": "Linked two services",
  "notif.event.depDeleted": "Unlinked two services",
  "notif.event.shareRequested": "Received a shared-value request",
  "notif.event.shareApproved": "Approved shared values",
  "notif.event.shareRevoked": "Revoked shared values",
  "notif.event.groupCreated": "Started a grouped update",
  "notif.event.autoUpdateOn": "Automatic updates turned on",
  "notif.event.autoUpdateOff": "Automatic updates turned off",
  "notif.event.autoUpdateFailed": "An automatic update could not finish",
  "notif.event.autoUpdateFailedNamed":
    "An automatic update for “{name}” could not finish",
  "notif.event.autoUpdateFailedDetail":
    "Review the update from the service screen",
  "notif.event.recorded": "Recorded activity",
  "notif.otherWorkspace": "Other workspace @{handle}",

  // --- activity -------------------------------------------------------------------
  "activity.title": "Activity history",
  "activity.subtitle": "Service and account events, newest first.",
  "activity.details": "Reference info",
  "activity.detailsBody": "Use these details when you need an event reference.",
  "activity.debug": "Reference ID",
  "activity.recorded": "Recorded activity",
  "activity.actorLine": "By {actor}",
  "activity.empty.title": "No activity yet",
  "activity.empty.message": "Operations in this workspace are recorded here.",

  // --- run group ---------------------------------------------------------------
  "runGroup.title": "Workspace update",
  "runGroup.subtitle":
    "Several service changes can be reviewed and approved together.",
  "runGroup.approveAll": "Approve all",
  "runGroup.approveAllConfirm.title": "Approve all changes?",
  "runGroup.approveAllConfirm.message":
    "This runs the pending changes for {n} services together.",
  "runGroup.approveAllConfirm.messageDanger":
    "This runs the pending changes for {n} services together, including destructive changes that delete resources. This can't be undone.",
  "runGroup.members": "Services in this update",
  "runGroup.membersEmpty": "No services in this update.",
  "runGroup.openService": "Open service",
  "runGroup.openServiceAria": "Open service “{name}”",
  "runGroup.openRun": "Review change",
  "runGroup.openRunAria": "Review change for “{name}”",
  "runGroup.groupId": "Update ID",
  "runGroup.progressStatus": "{done} of {total} complete",
  "runGroup.refreshFailed":
    "Couldn't fetch the latest status — showing the last loaded state.",

  // --- graph ---------------------------------------------------------------------
  "graph.title": "Dependencies",
  "graph.subtitle": "How services use values from other services.",
  "graph.layer": "Group {n}",
  "graph.cycle": "Needs review",
  "graph.dependsOn": "Uses {names}",
  "graph.empty.title": "No services",
  "graph.empty.message": "This workspace has no services yet.",
  "graph.noEdges.title": "No dependencies yet",
  "graph.noEdges.message":
    "Connections appear here once a service uses values from another service.",

  // --- account ---------------------------------------------------------------------
  "account.title": "Account",
  "account.subtitle": "Sign-in info, language, and appearance.",
  "account.profile.title": "Sign-in info",
  "account.profile.subject": "Sign-in reference",
  "account.profile.displayName": "Display name",
  "account.profile.email": "Email",
  "account.profile.notSet": "Not set",
  "account.profile.provider": "Sign-in method",
  "account.profile.expires": "Session expires",
  "account.session.userAgent": "Browser",
  "account.session.details": "Session details",
  "account.session.debug": "Reference ID",
  "account.session.signOut": "Sign out of this browser",
  "account.session.signOutConfirm": "Sign out of this browser?",
  "account.session.otherNote":
    "Only this browser's session can be signed out here.",
  "account.language.title": "Language",
  "account.theme.title": "Appearance",
  "account.preferences.title": "Display settings",
  "account.preferences.body": "Change language and appearance.",
  "account.installTarget.title": "Where store installs land",
  "account.installTarget.body":
    "Register this browser so a store’s “Add” button opens here, in this Takosumi. Once registered, add buttons on other stores also land here.",
  "account.installTarget.register": "Register this device",
  "account.installTarget.registered": "Registered on this device",
  "account.installTarget.done": "Registered — approve your browser’s prompt.",
  "account.installTarget.unsupported":
    "This browser doesn’t support this. Enter your instance URL on the store instead.",
  "account.apiKeys.title": "Cloud API keys",
  "account.apiKeys.subtitle":
    "Create and revoke keys for the CLI and external tools that use Takosumi Cloud.",
  "account.apiKeys.secretOnce": "Secret shown once",
  "account.apiKeys.name": "Key name",
  "account.apiKeys.namePlaceholder": "For example: Development CLI",
  "account.apiKeys.expiresLabel": "Expires in",
  "account.apiKeys.expiresDays": "{days} days",
  "account.apiKeys.scopes": "Permissions",
  "account.apiKeys.scope.read": "Read",
  "account.apiKeys.scope.write": "Write",
  "account.apiKeys.scope.admin": "Admin",
  "account.apiKeys.scopesHint":
    "Choose only what this key needs. Administrative access is operator-issued and cannot be created here.",
  "account.apiKeys.restrictWorkspace":
    "Restrict this key to the current Workspace",
  "account.apiKeys.create": "Create API key",
  "account.apiKeys.created": "API key created",
  "account.apiKeys.createdHint":
    "This value cannot be shown again. Save it somewhere secure now.",
  "account.apiKeys.copy": "Copy",
  "account.apiKeys.copied": "Copied",
  "account.apiKeys.copyFailed":
    "Could not copy the key. Save the visible value manually.",
  "account.apiKeys.error":
    "Could not complete the API key operation: {message}",
  "account.apiKeys.empty": "No API keys yet.",
  "account.apiKeys.key": "Key",
  "account.apiKeys.access": "Access",
  "account.apiKeys.workspaceBound": "Current Workspace only",
  "account.apiKeys.lastUsed": "Last used",
  "account.apiKeys.neverUsed": "Never",
  "account.apiKeys.status": "Status",
  "account.apiKeys.status.active": "Active",
  "account.apiKeys.status.revoked": "Revoked",
  "account.apiKeys.status.expired": "Expired",
  "account.apiKeys.expires": "Until {date}",
  "account.apiKeys.noExpiry": "No expiry",
  "account.apiKeys.action": "Action",
  "account.apiKeys.revoke": "Revoke",
  "account.apiKeys.revokeConfirm": "Revoke key",

  // --- billing -------------------------------------------------------------------
  "billing.usageQuotaTitle": "Usage overview",
  "billing.usageQuotaSubtitle":
    "Review this Workspace's recording mode and provider-neutral usage.",
  "billing.mode.disabled": "Showback is disabled for this Workspace.",
  "billing.mode.label": "Mode",
  "billing.mode.showback": "Usage is recorded, but nothing is charged.",
  "billing.loadError": "Could not load usage settings: {message}",
  "billing.usage.title": "Usage",
  "billing.usage.subtitle":
    "Recorded usage for this Workspace. Rated rows show the corresponding USD amount.",
  "billing.usage.more": "Load more",
  "billing.usage.error": "Could not load usage: {message}",
  "billing.usage.empty": "No usage yet.",
  "billing.usage.kind": "Kind",
  "billing.usage.time": "Time",
  "billing.usage.kind.runner_minute": "Runner time",
  "billing.usage.kind.operation": "Service operation",
  "billing.usage.kind.compute": "Compute",
  "billing.usage.kind.storage": "Storage",
  "billing.usage.quantity": "Quantity",
  "billing.usage.amount": "Rated amount",
  "billing.usage.unrated": "Unrated",
  "billing.commercial.pageTitle": "Prepaid credits and usage",
  "billing.commercial.pageSubtitle":
    "Review available credit, add prepaid credits, and manage auto-recharge.",
  "billing.commercial.description":
    "Prepaid credits fund Takosumi Cloud usage and do not expire.",
  "billing.commercial.loadError":
    "Could not load prepaid credit and payment details: {message}",
  "billing.commercial.actionError":
    "The billing action could not be completed: {message}",
  "billing.commercial.unavailable":
    "Payment setup is temporarily unavailable. Existing usage records are not affected.",
  "billing.commercial.checkout.success":
    "Your payment completed. The prepaid credits will appear after the payment provider confirms it.",
  "billing.commercial.checkout.cancelled":
    "Payment setup was cancelled. No changes were made.",
  "billing.commercial.manage": "Manage payment method",
  "billing.commercial.status.unknown": "Unknown",
  "billing.commercial.account.status.active": "Cloud usage available",
  "billing.commercial.account.status.trialing": "Cloud usage available",
  "billing.commercial.account.status.pastDue": "Payment needs attention",
  "billing.commercial.account.status.disabled": "Cloud usage suspended",
  "billing.commercial.account.blocked.paymentDisputed":
    "New Takosumi Cloud usage is blocked while a payment dispute is open. Your visible prepaid credit does not expire. Resolve the dispute in payment settings.",
  "billing.commercial.account.blocked.paymentPastDue":
    "New Takosumi Cloud usage is blocked because payment could not be confirmed. Your visible prepaid credit does not expire. Review your payment method.",
  "billing.commercial.account.blocked.disabled":
    "New Takosumi Cloud usage is blocked because the billing account is disabled. Your visible prepaid credit does not expire. Review payment settings.",
  "billing.commercial.account.blocked.suspended":
    "New Takosumi Cloud usage is blocked while the billing account needs attention. Your visible prepaid credit does not expire. Review payment settings.",
  "billing.commercial.lowCredit.autoRecharge":
    "Available credit is low. Auto-recharge will add prepaid credit at the saved threshold.",
  "billing.commercial.lowCredit.manual":
    "Available credit is low. Add prepaid credit to keep usage available.",
  "billing.commercial.customerType.label": "Account type",
  "billing.commercial.customerType.individual": "Individual",
  "billing.commercial.customerType.business": "Business",
  "billing.commercial.country.label": "Billing country",
  "billing.commercial.country.select": "Select a country",
  "billing.commercial.profile.title": "Billing profile",
  "billing.commercial.profile.hint":
    "Account type and country are fixed after payment setup.",
  "billing.commercial.balance.available": "Available credit",
  "billing.commercial.balance.reserved": "Reserved credit",
  "billing.commercial.balance.noExpiry":
    "Usage is deducted from available credit · prepaid credits do not expire",
  "billing.commercial.paymentMethod.ready": "Payment method ready",
  "billing.commercial.paymentMethod.missing": "No saved payment method",
  "billing.commercial.credits.title": "Add prepaid credits",
  "billing.commercial.credits.subtitle":
    "Choose a prepaid credit amount. Checkout securely saves the payment method, but auto-recharge stays off until you enable it below.",
  "billing.commercial.credits.choose": "Choose a prepaid credit amount",
  "billing.commercial.credits.taxNote":
    "Applicable tax is calculated by the payment provider at checkout.",
  "billing.commercial.credits.add": "Add prepaid credit",
  "billing.commercial.autoRecharge.title": "Auto-recharge",
  "billing.commercial.autoRecharge.subtitle":
    "Add prepaid credit when available credit falls below your threshold. The monthly cap is a hard safety limit.",
  "billing.commercial.autoRecharge.enable": "Enable auto-recharge",
  "billing.commercial.autoRecharge.requiresCard":
    "Add prepaid credit once to save a payment method before enabling auto-recharge.",
  "billing.commercial.autoRecharge.on": "On",
  "billing.commercial.autoRecharge.off": "Off",
  "billing.commercial.autoRecharge.onSummary":
    "Add {amount} of prepaid credit below {threshold}, up to {limit} per month",
  "billing.commercial.autoRecharge.threshold": "Available credit below",
  "billing.commercial.autoRecharge.amount": "Prepaid credit amount",
  "billing.commercial.autoRecharge.monthlyLimit": "Monthly maximum",
  "billing.commercial.autoRecharge.save": "Save auto-recharge",
  "billing.commercial.payment.title": "Credit payments",
  "billing.commercial.payment.subtitle":
    "Recent prepaid credit and auto-recharge payments.",
  "billing.commercial.payment.empty": "No credit payments yet.",
  "billing.commercial.payment.date": "Date",
  "billing.commercial.payment.status": "Status",
  "billing.commercial.payment.amount": "Amount",
  "billing.commercial.payment.action": "Receipt",
  "billing.commercial.payment.open": "Open",
  "billing.commercial.payment.count": "{count} credit payments",
  "billing.commercial.payment.status.paid": "Paid",
  "billing.commercial.payment.status.failed": "Failed",
  "billing.commercial.payment.status.partiallyRefunded": "Partially refunded",
  "billing.commercial.payment.status.refunded": "Refunded",
  "billing.commercial.payment.status.disputed": "Disputed",
  "billing.commercial.transaction.title": "Usage transactions",
  "billing.commercial.transaction.subtitle":
    "Charged and reversed wallet usage for this Workspace.",
  "billing.commercial.transaction.empty": "No usage transactions yet.",
  "billing.commercial.transaction.error":
    "Could not load usage transactions: {message}",
  "billing.commercial.transaction.more": "Load more",
  "billing.commercial.transaction.time": "Time",
  "billing.commercial.transaction.status": "Status",
  "billing.commercial.transaction.resource": "Resource",
  "billing.commercial.transaction.operation": "Operation / meter",
  "billing.commercial.transaction.quantity": "Quantity",
  "billing.commercial.transaction.amount": "Amount",
  "billing.commercial.transaction.status.charged": "Charged",
  "billing.commercial.transaction.status.reversed": "Reversed",
};
