import type { ja } from "./ja.ts";

/**
 * English dictionary. The `Record<keyof typeof ja, string>` constraint makes
 * `ja.ts` the single source of truth for the key set — a missing or extra key
 * here is a type error, so the locales cannot drift.
 */
export const en: Record<keyof typeof ja, string> = {
  // --- common -------------------------------------------------------------
  "common.loading": "Loading...",
  "common.retry": "Retry",
  "common.refresh": "Refresh",
  "common.create": "Create",
  "common.creating": "Creating...",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.saving": "Saving...",
  "common.delete": "Delete",
  "common.none": "None",
  "common.unknown": "Unknown",
  "common.details": "Details",
  "common.fetchFailed": "Failed to load — {message}",
  "common.copy": "Copy",
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
  "nav.services": "Services",
  "nav.add": "Add",
  "nav.store": "Store",
  "nav.settings": "Settings",
  "nav.graph": "Dependencies",
  "nav.resources": "Resources",
  "store.title": "Store",
  "store.subtitle": "Find services to add from the store.",
  "store.manualEntry":
    "Can't find what you need? Add from a Git URL / your own source",
  "nav.runs": "Activity",
  "nav.connections": "Connected accounts",
  "nav.billing": "Billing",
  "nav.activity": "History",
  "nav.primary": "Primary",
  "nav.notifications": "Notifications",
  "nav.workspaceSettings": "Settings",
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
  "settings.billing.desc": "Usage and operator-provided showback",
  "settings.notifications.title": "Notifications",
  "settings.notifications.desc": "Updates and items needing attention",
  "settings.billingSummary.manage": "Manage",
  "settings.billingSummary.error": "Couldn't load usage status.",
  "settings.manage.entry": "Management tools",
  "settings.manage.entryDesc":
    "Detailed screens for service internals, connections, and run history",
  "settings.manage.title": "Management tools",
  "settings.manage.subtitle":
    "Screens that work directly with hosting internals. You won't need these for everyday use.",
  "settings.manage.services": "Every service and its status",
  "settings.manage.connections": "Cloud account connections and keys",
  "settings.manage.runs": "Deploy and change execution records",
  "settings.manage.graph": "Dependencies between services",
  "settings.manage.resources":
    "Manage Resource Shapes, TargetPools, and SpacePolicy",
  "settings.manage.activity": "Who changed what, and when",
  "settings.manage.workspace": "Members, keys, backups, shares, policy",
  "settings.manage.backups": "Create and restore restore points",
  "settings.manage.shares": "Manage values shared between services",

  // --- workspace switcher -------------------------------------------------------
  "workspace.label": "Workspace",
  "workspace.loadFailed": "Failed to load workspaces — {message}",
  "workspace.none": "No workspaces",
  "workspace.select": "Select a workspace",
  "workspace.selectMessage":
    "Pick a workspace from the switcher in the sidebar.",
  "workspace.loading": "Loading workspaces...",
  "workspace.settings": "Workspace settings",
  "workspace.switcherAria": "Switch workspace (current: {name})",
  "workspace.defaultName": "My workspace",
  "workspace.start.aria": "Start workspace",
  "workspace.start.kicker": "No workspace yet",
  "workspace.start.title": "Create your workspace to start",
  "workspace.start.body":
    "Takosumi keeps your services, deploy history, and settings inside a workspace.",
  "workspace.start.create": "Create workspace",
  "workspace.start.creating": "Creating workspace...",
  "workspace.create.nameLabel": "Workspace name",
  "workspace.create.namePlaceholder": "New workspace",
  "workspace.create.nameRequired": "Enter a workspace name.",
  "workspace.create.idLabel": "Workspace ID",
  "workspace.create.idPlaceholder": "my-workspace",
  "workspace.create.idHelp":
    "Lowercase letters, numbers, and hyphens (2–39). Auto-generated if left blank.",
  "workspace.create.idInvalid":
    "Use 2–39 lowercase letters, numbers, or hyphens (no leading hyphen).",
  "workspace.create.idTaken": "That ID is already taken.",
  "workspace.create.failed": "Could not create the workspace — {message}",

  // --- auth -----------------------------------------------------------------
  "auth.signIn": "Sign in",
  "legal.langLabel": "Language",
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
  "auth.processing": "Signing you in...",
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
  "install.installingGeneric": "Adding…",
  "install.wait": "This only takes a moment",
  "install.progressAria": "Install progress",
  "install.step.fetch": "Fetch code",
  "install.step.check": "Check compatibility",
  "install.step.deploy": "Deploy",
  "install.step.done": "Finish",
  "install.doneTitle": "Added {name}",
  "install.doneTitleGeneric": "Added",
  "install.doneSub": "Deployed and ready to use.",
  "install.activationPending": "Finishing app activation…",
  "install.open": "Open app",
  "install.toApps": "Go to apps",
  "install.gateTitle": "Needs your review",
  "install.gateSub": "This install needs a quick review before it continues.",
  "install.gateCta": "Review",
  "install.errorTitle": "Couldn't add it",
  "install.errorSub": "Check the details and try again.",
  "install.errorCta": "See details",
  "update.installingGeneric": "Updating…",
  "update.doneTitle": "Updated {name}",
  "update.doneTitleGeneric": "Updated",
  "update.doneSub": "You're on the latest version.",
  "update.errorTitle": "The update failed",
  "apps.needsAttention": "Needs attention",
  "apps.openApp": "Open app",
  "apps.reviewChanges": "Review changes",
  "apps.start.aria": "First app",
  "apps.start.kicker": "No apps yet",
  "apps.start.titleEmpty": "Add your first app",
  "apps.start.bodyEmpty": "Choose an app or paste an install link.",
  "apps.start.optionStore": "Add an app",
  "apps.listIncomplete":
    "Some apps could not be loaded, so this screen may be missing apps.",

  // --- Service list (/services) --------------------------------------------
  "services.title": "Services",
  "services.subtitle": "Every service and its status. Open one for details.",
  "services.empty.title": "No services yet",
  "services.empty.body": "Services you add will appear here.",
  "services.deleteAria": "Delete {name}",
  "services.listIncomplete":
    "Some services could not be loaded, so this list may be incomplete.",

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
  "app.deploys.empty": "No deploys yet.",
  "app.deploys.restoreMenu": "More",
  "app.deploys.restore": "Restore this state",
  "app.deploys.restoreDisclosure": "Restore a previous version",
  "app.deploys.advancedActions": "Extra actions",
  "app.deploys.advancedActionsBody":
    "Use these only when you need a restore point or backup.",
  "app.deploys.backup": "Create backup",
  "app.deploys.backupCreated": "Backup created.",
  "app.deploys.backupSupportRef": "Backup ID",
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
  "app.bindings.aliasPlaceholder": "Target name (optional)",
  "app.bindings.aliasLabel": "Target name",
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
  "app.config.notReady": "Settings are not available yet.",
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
  "app.config.resetAria": "Clear setting {name}",
  "app.config.removeAria": "Remove setting {name}",
  "app.config.undoResetAria": "Undo resetting {name}",
  "app.config.defaultBadge": "Default value",
  "app.config.resetPendingHint": "Reverts to the default when you save.",
  "app.config.customName": "CUSTOM_ENV",
  "app.config.errorNameRequired": "Enter a setting name.",
  "app.config.errorNameInvalid": "{name} cannot contain spaces.",
  "app.config.errorNameDuplicate": "{name} is duplicated.",
  "app.config.errorNumber": "{name} must be a number.",
  "app.config.errorJson": "{name} must be valid JSON.",
  "app.interfaces.title": "Runtime interfaces (advanced)",
  "app.interfaces.subtitle":
    "Declare runtime surfaces separately from ordinary OpenTofu outputs. Changes apply on the next deploy review.",
  "app.interfaces.editorLabel": "Interface blueprints (JSON)",
  "app.interfaces.editorHint":
    "Use an array. Each declaration explicitly provides key, name, and spec. Put dynamic mappings under spec.inputs with a literal, capsule_output, or resource_output source. Do not put secrets here.",
  "app.interfaces.notReady": "Interface declarations are not available yet.",
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
  "run.summary.applySucceeded": "Deploy complete.",
  "run.summary.removing": "Removing…",
  "run.summary.removed": "Removal complete.",
  "run.summary.failed": "{operation} failed.",
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
  "run.approving": "Approving...",
  "run.deploy": "Deploy",
  "run.deploying": "Deploying...",
  "run.deployBlocked": "Deploy blocked",
  "run.retryPlan": "Review changes again",
  "run.backToApp": "Back to service",
  "run.appHandoff.open": "Open in {app}",
  "run.destructiveWarning":
    "This change replaces or deletes existing resources. Running it may lose data.",
  "run.destructiveConfirm": "Run destructive changes anyway",
  "run.stopGoBack": "Go back",
  "run.cancel": "Cancel this run",
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
  "run.cost.quotaCta": "Review usage / quota",
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
  "runList.title": "Activity",
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
  "new.title": "Add service",
  "new.discard.title": "Discard your entries?",
  "new.discard.body": "The setup you entered for this service won't be saved.",
  "new.discard.confirm": "Discard",
  "new.discovery.aria": "Find a service to add",
  "new.discovery.title": "Choose a service to add",
  "new.discovery.subtitle": "Pick a service to add.",
  "new.discovery.linkPlaceholder": "Install link or Git URL",
  "new.discovery.linkCta": "Add from link",
  "new.discovery.manualLead": "Can't find what you need?",
  "new.discovery.manualToggle": "Add from a Git URL / install link",
  "new.advancedImport.title": "Add from link",
  "new.advancedImport.subtitle": "Paste an install link to add it.",
  "new.selection.subtitle": "Check it first. Deploy happens after review.",
  "new.flow.selected": "Selected",
  "new.flow.manual": "Manual add",
  "new.flow.back": "Choose a different service",
  "new.pick.checking": "Checking the selected service…",
  "new.summary.aria": "Add summary",
  "new.summary.provider": "Runs on",
  "new.storeInput.title": "Service setup",
  "new.storeInput.subtitle":
    "Name the service and fill the minimum fields needed to publish it.",
  "new.storeInput.errorRequired": "Enter {label}.",
  "new.storeInput.errorUnsafeValue":
    "{label} contains unsupported characters or is too long.",
  "new.storeInput.errorSubdomain":
    "Use a single {baseDomain} label for {label}. Lowercase letters, numbers, and hyphens are supported.",
  "new.storeInput.errorCustomDomain":
    "Use an https:// URL for {label}. {baseDomain} names must use one label; custom domains require ownership verification before deploy.",
  "new.deeplink.aria": "Service from link",
  "new.deeplink.kicker": "Added from link",
  "new.deeplink.title": "Add {capsule}",
  "new.deeplink.body":
    "We checked the link details. Open the source if you need to change anything.",
  "new.deeplink.source": "Source",
  "new.deeplink.version": "Version",
  "new.deeplink.folder": "Folder",
  "new.git.url": "Install link",
  "new.git.advanced": "Source details",
  "new.git.ref": "Version",
  "new.git.defaultRef": "Git default branch",
  "new.git.path": "Folder",
  "new.sourceAccess.title": "Private link access",
  "new.sourceAccess.body":
    "Public links need no setup. For a private link, select or save access information.",
  "new.sourceAccess.mode": "Access method",
  "new.sourceAccess.public": "Public link",
  "new.sourceAccess.existing": "Use saved access",
  "new.sourceAccess.token": "Save access token",
  "new.sourceAccess.connection": "Saved access",
  "new.sourceAccess.selectConnection": "Select saved access",
  "new.sourceAccess.noConnections":
    "No verified source access is available in this workspace yet.",
  "new.sourceAccess.username": "Username",
  "new.sourceAccess.accessToken": "Access token",
  "new.sourceAccess.tokenPlaceholder": "Read-only token",
  "new.sourceAccess.saveToken": "Save access",
  "new.sourceAccess.tokenBody":
    "It is stored securely and cannot be read back, and is used only to check this workspace's source.",
  "new.sourceAccess.errorTokenRequired": "Enter an access token.",
  "new.sourceAccess.errorSaveToken":
    "Save the private link token before checking.",
  "new.sourceAccess.errorSelectConnection": "Select verified source access.",
  "new.sourceAccess.errorConnectionUnavailable":
    "The selected source access is no longer available.",
  "new.sourceAccess.httpsConnection": "HTTPS source access",
  "new.sourceAccess.sshConnection": "SSH source access",
  "new.sourceAccess.defaultDisplayName": "{name} source access",
  "new.name": "Service name",
  "new.vars.projectName": "Service ID",
  "new.hostPreview": "Public URL: {host}",
  "new.hostname.mode.label": "URL type",
  "new.hostname.mode.hint":
    "Standard URLs are available per Workspace. A short URL consumes one account URL slot.",
  "new.hostname.mode.scoped": "Standard URL",
  "new.hostname.mode.vanity": "Use a short URL slot",
  "new.advanced.title": "Advanced settings",
  "new.advanced.customUrlHint":
    "A full URL used instead of the default public URL.",
  "new.advanced.routePatternHint": "Advanced: set the route pattern directly.",
  "new.advanced.serviceIdHint": "Internal name. Also the default for the URL.",
  "new.env.title": "Environment variables",
  "new.env.body":
    "Use this only for runtime environment variables the service can store in plain text. Pass private values through connected accounts.",
  "new.env.name": "Variable name",
  "new.env.value": "Value",
  "new.env.valuePlaceholder": "value",
  "new.env.add": "Add environment variable",
  "new.env.remove": "Remove",
  "new.env.errorNameRequired":
    "Enter an environment variable name or remove the empty row.",
  "new.env.errorUnsafeName":
    "“{name}” must use uppercase letters, digits, and underscores.",
  "new.env.errorUnsafeValue":
    "The value for “{name}” is too long or contains an unsupported character.",
  "new.env.errorDuplicate":
    "Environment variable “{name}” is listed more than once.",
  "new.vars.inputsTitle": "Other settings",
  "new.vars.inputsBody":
    "Add extra visible inputs only when the service asks for something not shown above.",
  "new.vars.inputName": "Setting name",
  "new.vars.inputValue": "Value",
  "new.vars.namePlaceholder": "setting",
  "new.vars.valuePlaceholder": "value",
  "new.vars.addInput": "Add input",
  "new.vars.removeInput": "Remove",
  "new.vars.errorNameRequired":
    "Enter a variable name or remove the empty row.",
  "new.vars.errorUnsafeName":
    "“{name}” cannot be passed as a link/input value. Use connected accounts for private values.",
  "new.vars.errorUnsafeValue":
    "The value for “{name}” is too long or contains an unsupported character.",
  "new.vars.errorProjectNameReserved":
    "Use the Service ID field for this value.",
  "new.vars.errorStoreReserved": "Use the Service setup field for “{name}”.",
  "new.vars.errorDuplicate": "“{name}” is listed more than once.",
  "new.deeplink.invalidTitle": "This install link cannot be used",
  "new.deeplink.invalidBody":
    "The link is not a safe HTTPS link, or it includes information this browser cannot open. Choose a service or paste another link.",
  "new.appHandoff.title": "Add a service for {app}",
  "new.appHandoff.body":
    "When the add completes here, the connection details return to the app automatically.",
  "new.appHandoff.kicker": "Requested by an app",
  "new.appHandoff.app": "App",
  "new.appHandoff.return": "Return target",
  "new.installCta": "Add service",
  "new.installing": "Adding...",
  "new.compat.recheck": "Check again",
  "new.compat.checking": "Preparing...",
  "new.progress.title": "Preparing the service",
  "new.progress.fetching": "Fetching the contents. Keep this page open.",
  "new.progress.slow":
    "This is taking a little longer. You can continue when it finishes.",
  "new.progress.details": "Detailed progress",
  "new.progress.status": "Status: {status}",
  "new.compat.title": "Check result",
  "new.compat.details": "Detailed check result",
  "new.compat.readyBrief": "Ready to continue.",
  "new.compat.ready": "Can be added as is",
  "new.compat.patch": "Needs manual changes",
  "new.compat.unsupported": "Cannot be added right now",
  "new.compat.diagnostic.technicalNote":
    "Detailed check result. Open it only when action is needed.",
  "new.compat.patchHelp":
    "Review the items above. Some issues require changes to the service itself, while others can be resolved by setting up the required connected account.",
  "new.compat.summary.providerCredentials":
    "Remove {provider} private values from the source before adding this.",
  "new.compat.summary.reviewRequired":
    "An item needs review before this can be added.",
  "new.compat.issue.providerCredentials.message":
    "{provider} private values are written in the source.",
  "new.compat.issue.providerCredentials.detail":
    "Do not keep API tokens or account IDs in code. Remove those values, then connect {provider} access so Takosumi can pass them only while deploying.",
  "new.compat.issue.providerPreserved.message":
    "The repository's non-secret {provider} configuration will be preserved.",
  "new.compat.issue.backendIsolated.message":
    "The repository backend configuration is preserved while Takosumi isolates the Run state boundary.",
  "new.compat.issue.lockfile.message":
    "Pinned connection target information is included. After private values are removed, the pinned targets will be reviewed during add.",
  "new.compat.issue.reviewRequired.message":
    "An item needs review before this can be added.",
  "new.proceedHint": "Use “Add service” first.",
  "new.existing.title": "This service is already added",
  "new.existing.body":
    "“{name}” already exists in the {environment} environment. Open the existing service instead of creating another one.",
  "new.existing.open": "Open existing service",
  "new.providers.title": "Connected account to use",
  "new.providers.alias": "Target: {alias}",
  "new.providers.selectConnection": "Select connected account",
  "new.providers.errorConnection":
    "Select a ready connected account for {provider}.",
  "new.providers.missingTitle": "Connected account is required",
  "new.providers.missingBody": "Set up a connected account to continue.",
  "new.providers.setupMissing": "Set up required connected account",
  "new.providers.returnNote":
    "After you save the connection, you return here to finish adding.",
  "new.step.technical": "Detailed progress",
  "new.step.register": "Prepare service",
  "new.step.sync": "Fetch content",
  "new.step.create": "Create service",
  "new.step.plan": "Review changes",
  "new.step.state.done": "Done",
  "new.step.state.failed": "Failed",
  "new.step.state.running": "In progress",
  "new.step.state.pending": "Not started",
  "new.error.workspaceRequired": "Select a workspace.",
  "new.error.urlRequired": "Enter an install link.",
  "new.error.nameRequired": "Enter a name.",
  "new.error.nameInvalid":
    "Use lowercase letters, numbers, and hyphens only for the service name.",
  "new.error.configMissing": "Add configuration is not available yet.",
  "new.error.configLoading": "Loading add configuration.",
  "new.error.configLoadFailed":
    "The add settings could not be loaded. Check your connection and retry.",
  "new.error.syncPending":
    "The source has not finished syncing. Wait a moment, then retry.",
  "new.error.sourceRefNotFound":
    "The selected version “{ref}” was not found. Check that the link offers this version.",
  "new.error.sourceFetchFailed":
    "The service contents could not be fetched. Check the link, version, folder, or private link access. Details: {message}",
  "new.error.sourceFetchFailedUnknown": "No detailed cause was returned.",
  "new.error.generic":
    "The service could not be added. Check the details and try again.",
  "new.error.genericWithDetails":
    "The service could not be added. Details: {message}",
  "new.error.requestId":
    "If this keeps happening, contact support with this ID: {id}",
  "new.error.invalidHostname":
    "This public name is too long or has characters that cannot be used. Try a shorter name.",
  "new.error.connectionRequired":
    "Publishing this service needs a connected cloud account. Set up the connection, then try again.",
  "new.error.appHostnameUnavailable":
    "That public URL name is already in use. Choose another name and try again.",
  "new.hostnameConflict.title": "Choose another public URL name",
  "new.error.managedHostnameSlotLimit":
    "No short URL slots are available. Use a standard URL or release an existing short URL.",
  "new.hostnameConflict.body":
    "Use a different name for the public URL, then add the service again.",
  "new.hostnameConflict.suggest": "Use suggested name",
  "new.error.alreadyExistsGeneric":
    "This service is already added. Open the existing service instead of creating another one.",
  "new.error.nameReserved":
    "That service name is reserved but was not found in the current list. Refresh services, delete the unfinished service if it appears, or choose another name.",
  "new.error.notRunnable":
    "This service cannot be added yet. Resolve the listed items, then check again.",

  // --- workspace settings ---------------------------------------------------------
  "workspaceSettings.title": "Settings",
  "workspaceSettings.tabsLabel": "Settings sections",
  "workspaceSettings.subtitle":
    "Review the workspace name, members, connected accounts, and usage.",
  "workspaceSettings.tab.general": "General",
  "workspaceSettings.tab.members": "Members",
  "workspaceSettings.tab.connections": "Connections",
  "workspaceSettings.tab.billing": "Billing",
  "workspaceSettings.tab.usageQuota": "Usage / quota",
  "workspaceSettings.tab.keys": "API keys",
  "workspaceSettings.tab.backups": "Backups",
  "workspaceSettings.tab.shares": "Shared values",
  "workspaceSettings.general.displayName": "Display name",
  "workspaceSettings.general.handle": "Handle",
  "workspaceSettings.general.type": "Type",
  "workspaceSettings.general.owner": "Owner",
  "workspaceSettings.general.updated": "Updated",
  "workspaceSettings.general.advancedDetails": "Advanced details",
  "workspaceSettings.general.saved": "Settings saved.",
  "workspaceSettings.general.archive": "Archive workspace",
  "workspaceSettings.general.archiveConfirm":
    "This workspace will be hidden from the normal switcher. You can still inspect it through the admin API.",
  "workspaceSettings.general.archivedNamed": "Archived “{name}”.",
  "workspaceSettings.general.archivedHint":
    "You can restore it from the archived list below, or move to another workspace with the workspace switcher.",
  "workspaceSettings.general.notFound":
    "This workspace was not found. Switch workspaces, or restore one below.",
  "workspaceSettings.general.archivedTitle": "Archived workspaces",
  "workspaceSettings.general.unarchive": "Restore",
  "workspaceSettings.general.archiveLastError":
    "You cannot archive the last workspace.",
  "workspaceSettings.general.nameRequired": "Enter a display name.",

  // --- members ---------------------------------------------------------------
  "members.role.owner": "Owner",
  "members.role.admin": "Admin",
  "members.role.member": "Member",
  "members.role.viewer": "Viewer",
  "members.status.active": "Active",
  "members.status.invited": "Invited",
  "members.status.suspended": "Suspended",
  "members.invite.title": "Invite a member",
  "members.invite.subtitle":
    "Enter the email for someone who has already signed in.",
  "members.invite.email": "Email",
  "members.invite.role": "Role",
  "members.invite.cta": "Invite",
  "members.invite.emailRequired": "Enter an email address.",
  "members.invite.success": "Invited {email}.",
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
  "members.removeConfirm": "Remove this member? ({account})",
  "members.empty": "This workspace has no members yet.",
  "members.viewerNote":
    "Only owners and admins can invite, change roles, or remove members.",

  // --- connections -------------------------------------------------------------
  "conn.subtitle":
    "Save your own keys (cloud tokens and access keys). With your key, any provider runs — no restrictions, no approval needed.",
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
  "conn.byok.title": "Connect any provider with your own key",
  "conn.byok.body":
    "Just enter where the provider comes from (its source) and the environment variables (keys) it uses. No restrictions, no approval — any OpenTofu / Terraform provider runs.",
  "conn.byok.noBillingNote":
    "Connections that use your own key are never billed by Takosumi. Only resources Takosumi provides are billed.",
  "conn.byok.usePreset": "Use an installed recipe instead",
  "conn.register": "Save connection",
  "conn.registering": "Saving...",
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
  "conn.empty.title": "Connect any provider with your own key",
  "conn.empty.message":
    "Enter your own key (a cloud token or key) and any provider runs — no restrictions, no approval, no billing.",
  "conn.test": "Check access",
  "conn.testing": "Checking...",
  "conn.test.notReady": "The account is not ready yet (status: {status}).",
  "conn.remove.confirmTitle": "Delete connected account",
  "conn.remove.confirmMessage":
    "Really delete {name}? Its saved access values are deleted too. This cannot be undone.",
  "conn.remove.bindingWarning":
    "Capsule runs that use this connection will fail.",

  // --- backups -----------------------------------------------------------------
  "backups.subtitle": "Manage restore points for this workspace.",
  "backups.create": "Create backup",
  "backups.creating": "Creating a backup.",
  "backups.col.createdAt": "Created",
  "backups.col.contents": "Contents",
  "backups.col.actions": "Actions",
  "backups.restorePoint": "Restore point",
  "backups.restoreGeneration": "Backup point {generation}",
  "backups.restore": "Prepare restore",
  "backups.restoreUnavailable":
    "Create a backup from a service before restoring it.",
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

  // --- Resource Shape ----------------------------------------------------------
  "resources.title": "Resources",
  "resources.subtitle":
    "Manage desired state, placement, and observations for Resource Shapes.",
  "resources.define": "Define resource",
  "resources.empty": "This Resource Space has no resources.",
  "resources.column.resource": "Resource",
  "resources.column.phase": "Phase",
  "resources.column.target": "Target",
  "resources.column.managedBy": "Managed by",
  "resources.scope.title": "Resource Space",
  "resources.scope.subtitle":
    "For dashboard sessions, the verified Workspace ID is the Resource Space boundary.",
  "resources.scope.label": "Space ID",
  "resources.scope.required": "A Resource Space is required.",
  "resources.unavailable.title": "Resource Shape API is disabled",
  "resources.unavailable.message":
    "This operator has not enabled the durable Resource Shape API and runner yet.",
  "resources.inventory.title": "Resource inventory",
  "resources.inventory.subtitle": "Desired and observed state in Space {space}",
  "resources.editor.createTitle": "Define resource",
  "resources.editor.editTitle": "Change desired state",
  "resources.editor.subtitle":
    "Choose a service and its required inputs, then review price and preview before deploying.",
  "resources.editor.serviceStep": "Choose a service",
  "resources.editor.service": "Service",
  "resources.editor.serviceHint":
    "Choose the service form you need, not a provider or backend implementation.",
  "resources.editor.service.edgeWorker": "Edge Worker",
  "resources.editor.service.objectBucket": "Object Bucket",
  "resources.editor.service.kvStore": "KV Store",
  "resources.editor.service.sqlDatabase": "SQL Database",
  "resources.editor.service.queue": "Queue",
  "resources.editor.service.vectorIndex": "Vector Index",
  "resources.editor.service.durableWorkflow": "Durable Workflow",
  "resources.editor.service.containerService": "Container",
  "resources.editor.service.statefulActorNamespace": "Stateful Actor Namespace",
  "resources.editor.service.schedule": "Schedule",
  "resources.editor.service.custom": "Operator / custom Shape",
  "resources.editor.stable": "Stable",
  "resources.editor.stableHint":
    "The Resource Shapes available to you use the same Stable Deploy API. This list comes from the host's Form availability contract.",
  "resources.editor.customHint":
    "Operator-defined Shapes use a kind and raw Spec JSON under advanced settings. The endpoint decides availability.",
  "resources.editor.inputsStep": "Required inputs",
  "resources.editor.inputsHint":
    "Do not enter credentials or provider-specific configuration here.",
  "resources.editor.kind": "Shape kind",
  "resources.editor.kindHint":
    "Use a bundled shape or a token explicitly registered by the operator.",
  "resources.editor.kindInvalid": "Enter a valid Shape kind.",
  "resources.editor.formUnavailable":
    "No exact Service Form is available to your account in this Space.",
  "resources.editor.name": "Service name",
  "resources.editor.nameRequired": "Enter a service name.",
  "resources.editor.artifactSource": "Immutable artifact source",
  "resources.editor.artifactSource.url": "HTTPS release URL",
  "resources.editor.artifactSource.ref": "Operator-issued artifact ref",
  "resources.editor.artifactUrl": "Artifact URL",
  "resources.editor.artifactUrlHint":
    "An immutable HTTPS URL published by CI or a release. Takosumi does not build the bundle.",
  "resources.editor.artifactRef": "Artifact ref",
  "resources.editor.artifactRefHint":
    "An opaque immutable reference issued by this endpoint. Do not include provider names or credentials.",
  "resources.editor.artifactSha": "Artifact SHA-256",
  "resources.editor.artifactShaHint":
    "The digest that the fetched artifact must match.",
  "resources.editor.artifactUrlRequired": "Enter the artifact URL.",
  "resources.editor.artifactUrlHttps":
    "The artifact URL must start with https://.",
  "resources.editor.artifactRefRequired": "Enter the artifact ref.",
  "resources.editor.artifactShaRequired":
    "Enter the SHA-256 used to verify the immutable artifact.",
  "resources.editor.compatibilityDate": "Compatibility date (optional)",
  "resources.editor.compatibilityFlags": "Compatibility flags (optional)",
  "resources.editor.profiles": "Required profiles (optional)",
  "resources.editor.profilesHint":
    "Profile tokens are advertised and validated by the endpoint; the dashboard does not own a fixed list.",
  "resources.editor.tokenListHint":
    "Separate multiple tokens with commas or whitespace.",
  "resources.editor.bucketStorageClass": "Storage class",
  "resources.editor.bucketStorageClass.standard": "Standard",
  "resources.editor.bucketStorageClass.infrequentAccess": "Infrequent access",
  "resources.editor.bucketStorageClassHint":
    "Portable default for newly written objects. Infrequent access requires a target that advertises support.",
  "resources.editor.bucketInterfaces": "Required object interfaces",
  "resources.editor.bucketInterfacesHint":
    "For example: s3_api, signed_url. These are endpoint-validated capability tokens, not runtime Interface objects.",
  "resources.editor.operatorDefault": "Operator default",
  "resources.editor.capabilityTokenHint":
    "Optional capability token advertised and validated by the endpoint.",
  "resources.editor.kvConsistency": "Consistency (optional)",
  "resources.editor.kvConsistency.eventual": "Eventual",
  "resources.editor.kvConsistency.strong": "Strong",
  "resources.editor.sqlEngine": "Engine capability (optional)",
  "resources.editor.sqlMigrationsPath": "Migrations path (optional)",
  "resources.editor.queueMaxRetries": "Maximum retries (optional)",
  "resources.editor.queueMaxBatchSize": "Maximum batch size (optional)",
  "resources.editor.queueMaxRetriesInvalid":
    "Maximum retries must be a non-negative integer.",
  "resources.editor.queueMaxBatchSizeInvalid":
    "Maximum batch size must be a non-negative integer.",
  "resources.editor.vectorDimensions": "Dimensions",
  "resources.editor.vectorMetric": "Similarity metric (optional)",
  "resources.editor.vectorDimensionsInvalid":
    "Dimensions must be a positive integer.",
  "resources.editor.workflowEntrypoint": "Entrypoint",
  "resources.editor.workflowMaxAttempts": "Maximum attempts (optional)",
  "resources.editor.workflowBackoff": "Initial backoff in seconds (optional)",
  "resources.editor.workflowEntrypointRequired":
    "Enter the workflow entrypoint.",
  "resources.editor.workflowMaxAttemptsInvalid":
    "Maximum attempts must be a positive integer.",
  "resources.editor.workflowBackoffInvalid":
    "Initial backoff must be a non-negative integer.",
  "resources.editor.containerImage": "OCI image",
  "resources.editor.containerPorts": "Ports (optional)",
  "resources.editor.integerListHint":
    "Separate positive integers with commas or whitespace.",
  "resources.editor.containerPublicHttp": "Public HTTP (optional)",
  "resources.editor.containerPublicHttp.enabled": "Enabled",
  "resources.editor.containerPublicHttp.disabled": "Disabled",
  "resources.editor.containerEnvironment": "Environment JSON (optional)",
  "resources.editor.containerEnvironmentHint":
    "A JSON object whose values are non-secret strings. Use Secret or Credential for sensitive values.",
  "resources.editor.containerImageRequired": "Enter an OCI image reference.",
  "resources.editor.containerPortsInvalid":
    "Ports must be positive integers separated by commas or whitespace.",
  "resources.editor.containerEnvironmentInvalid":
    "Environment must be a JSON object whose values are strings.",
  "resources.editor.actorClass": "Runtime class",
  "resources.editor.actorStorageProfile": "Storage profile (optional)",
  "resources.editor.actorMigrationTag": "Migration tag (optional)",
  "resources.editor.actorClassRequired": "Enter the runtime class name.",
  "resources.editor.actorClassInvalid":
    "Runtime class must be a valid class identifier.",
  "resources.editor.scheduleCron": "Cron expression",
  "resources.editor.scheduleCronHint":
    "Use a portable five-field cron expression.",
  "resources.editor.scheduleTimezone": "Timezone (optional)",
  "resources.editor.scheduleConnection": "Connection name",
  "resources.editor.scheduleTarget": "Target resource",
  "resources.editor.scheduleTargetHint":
    "Resource reference invoked through the schedule_trigger projection.",
  "resources.editor.scheduleCronRequired": "Enter a cron expression.",
  "resources.editor.scheduleCronInvalid":
    "Cron must contain exactly five fields.",
  "resources.editor.scheduleConnectionInvalid":
    "Connection name must be a non-empty token without whitespace.",
  "resources.editor.scheduleTargetRequired":
    "Enter a target Resource reference without whitespace.",
  "resources.editor.project": "Project (optional)",
  "resources.editor.environment": "Environment",
  "resources.editor.targetPool": "TargetPool",
  "resources.editor.policy": "SpacePolicy",
  "resources.editor.spec": "Spec JSON",
  "resources.editor.specHint":
    "Enter only the selected Shape's spec as a JSON object. Do not include credentials.",
  "resources.editor.advanced": "Advanced and operator settings",
  "resources.editor.advancedHint":
    "Set Project, Environment, TargetPool, SpacePolicy, or labels only when needed. Ordinary deploys can use operator defaults.",
  "resources.editor.rawOptInHint":
    "Switch to raw Spec JSON only for connections, lifecycle policy, or operator extensions.",
  "resources.editor.useRawSpec": "Use raw Spec JSON",
  "resources.editor.rawWarning":
    "This is the custom Shape and operator path. The Deploy API decides schema, availability, and price.",
  "resources.editor.rawCannotGuide":
    "The raw Spec JSON contains settings the guided form does not handle. It stayed in raw mode to avoid losing them.",
  "resources.editor.labels": "Labels JSON",
  "resources.editor.labelsHint": "A JSON object whose values are all strings.",
  "resources.editor.specInvalid": "Invalid Spec JSON — {message}",
  "resources.editor.labelsInvalid": "Invalid Labels JSON — {message}",
  "resources.editor.preview": "Preview",
  "resources.editor.previewStep": "Price and preview",
  "resources.editor.previewHint":
    "Resolve the current inputs and fetch the endpoint's price, placement, and execution plan. Nothing is deployed yet.",
  "resources.editor.previewRequired":
    "Preview the current inputs again before continuing.",
  "resources.editor.deployStep": "Review and deploy",
  "resources.editor.deployHint":
    "After preview, confirm that inputs are unchanged and deploy with the exact same plan and quote.",
  "resources.editor.apply": "Deploy service",
  "resources.editor.applied": "Service desired state applied.",
  "resources.editor.importExisting": "Import an existing native resource",
  "resources.editor.nativeId": "Native resource ID",
  "resources.editor.nativeIdHint":
    "The identifier issued by the provider. Do not enter credentials.",
  "resources.editor.nativeIdRequired": "Enter the native resource ID.",
  "resources.editor.import": "Import",
  "resources.editor.imported": "Existing resource imported.",
  "resources.confirm.applyTitle": "Deploy this service?",
  "resources.confirm.updateTitle": "Change this desired state?",
  "resources.confirm.applyMessage":
    "Deploy {kind}/{name} to Target {target}. Reviewed price: {price}. Only the exact previewed plan and quote will run.",
  "resources.confirm.importTitle": "Import this existing resource?",
  "resources.confirm.importMessage":
    "Validate native ID {nativeId} and place it under Takosumi management as {kind}/{name}.",
  "resources.preview.title": "Preview result",
  "resources.preview.current": "Current inputs",
  "resources.preview.changed": "Inputs have changed",
  "resources.preview.target": "Target",
  "resources.preview.implementation": "Implementation",
  "resources.preview.portability": "Portability",
  "resources.preview.price": "Estimated price",
  "resources.preview.noQuoteShort": "No price quote",
  "resources.preview.noQuote":
    "This preview did not include a price quote. OSS Takosumi does not own the Cloud price catalog; check the operator's billing mode and guidance. This does not mean free.",
  "resources.preview.unratedShort": "Unrated",
  "resources.preview.unrated":
    "This quote is unrated. OSS disabled/showback operation may still apply it, but it does not represent a price or charge.",
  "resources.preview.ratedHint":
    "Estimated total from the endpoint's versioned quote. Deploy presents this exact quote again.",
  "resources.preview.quote": "Quote ID",
  "resources.preview.catalog": "Price catalog",
  "resources.preview.offering": "Offering",
  "resources.preview.region": "Region",
  "resources.preview.priceExpires": "Quote expires",
  "resources.preview.lineItems": "Exact price lines",
  "resources.preview.unitPrice": "unit price",
  "resources.preview.subtotal": "subtotal",
  "resources.preview.tax": "tax",
  "resources.preview.technicalDetails": "Placement and native plan details",
  "resources.preview.nativePlan": "Native plan",
  "resources.preview.risks": "Risk notes",
  "resources.preview.noRisks": "No additional risk notes.",
  "resources.targetPools.title": "TargetPools",
  "resources.targetPools.subtitle":
    "Declare available Targets and implementation descriptors in priority order.",
  "resources.targetPools.add": "Add TargetPool",
  "resources.targetPools.empty": "No TargetPools.",
  "resources.targetPools.column.name": "Name",
  "resources.targetPools.column.targets": "Targets",
  "resources.targetPools.column.updated": "Updated",
  "resources.targetPools.edit": "Edit",
  "resources.targetPools.editorTitle": "TargetPool configuration",
  "resources.targetPools.name": "TargetPool name",
  "resources.targetPools.nameRequired": "Enter a TargetPool name.",
  "resources.targetPools.spec": "TargetPool spec JSON",
  "resources.targetPools.specInvalid":
    "Enter a valid JSON object containing a targets array.",
  "resources.targetPools.saved": "TargetPool saved.",
  "resources.targetPools.deleteTitle": "Delete this TargetPool?",
  "resources.targetPools.deleteMessage":
    "Delete TargetPool {name}. The request is rejected while a Resource pins it.",
  "resources.targetPools.deleteAria": "Delete TargetPool {name}",
  "resources.config.noSecrets":
    "Enter only non-secret descriptors here. Store credentials in a Provider Connection.",
  "resources.policy.title": "Advanced SpacePolicy",
  "resources.policy.subtitle":
    "Configure placement constraints, preferences, and approvals as JSON",
  "resources.policy.add": "Add SpacePolicy",
  "resources.policy.empty": "No SpacePolicies.",
  "resources.policy.column.name": "Name",
  "resources.policy.column.updated": "Updated",
  "resources.policy.edit": "Edit",
  "resources.policy.editorTitle": "SpacePolicy configuration",
  "resources.policy.name": "SpacePolicy name",
  "resources.policy.nameRequired": "Enter a SpacePolicy name.",
  "resources.policy.spec": "SpacePolicy spec JSON",
  "resources.policy.specInvalid": "Enter a valid JSON object.",
  "resources.policy.saved": "SpacePolicy saved.",
  "resources.policy.deleteTitle": "Delete this SpacePolicy?",
  "resources.policy.deleteMessage": "Delete SpacePolicy {name}.",
  "resources.policy.deleteAria": "Delete SpacePolicy {name}",
  "resources.policy.writeOnlyHint":
    "Saving replaces the policy with the same name. Do not include credentials or secrets.",
  "resources.detail.subtitle":
    "State and operation history in Resource Space {space}",
  "resources.detail.back": "Resource inventory",
  "resources.detail.observe": "Observe",
  "resources.detail.refresh": "Refresh state",
  "resources.detail.actionComplete": "Operation complete.",
  "resources.detail.loadFailed": "Could not load this resource",
  "resources.detail.status": "Current status",
  "resources.detail.kind": "Kind",
  "resources.detail.space": "Space",
  "resources.detail.managedBy": "Managed by",
  "resources.detail.generation": "Observed generation",
  "resources.detail.resolution": "ResolutionLock",
  "resources.detail.locked": "Locked",
  "resources.detail.yes": "Yes",
  "resources.detail.no": "No",
  "resources.detail.desired": "Desired state",
  "resources.detail.desiredHint":
    "The spec stays folded, and every change must be previewed again.",
  "resources.detail.change": "Change",
  "resources.detail.showSpec": "Show Spec JSON",
  "resources.detail.conditions": "Conditions",
  "resources.detail.conditionsHint": "Public reconcile and drift status",
  "resources.detail.outputs": "Output keys",
  "resources.detail.outputsHint":
    "Values stay hidden here; only public key names are listed.",
  "resources.detail.events": "Operation history",
  "resources.detail.eventsHint": "Non-secret Activity / Run projections",
  "resources.detail.noEvents": "No operation history yet.",
  "resources.detail.deleteTitle": "Delete this resource?",
  "resources.detail.deleteMessage":
    "Run normal deletion for {kind}/{name} and its native resources. This screen never uses force delete.",

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

  // --- billing -------------------------------------------------------------------
  "billing.subtitle": "Review provider-neutral usage and showback records.",
  "billing.usageQuotaTitle": "Showback",
  "billing.usageQuotaSubtitle":
    "Review this Workspace's recording mode and provider-neutral usage.",
  "billing.mode.disabled": "Showback is disabled for this Workspace.",
  "billing.mode.label": "Mode",
  "billing.mode.showback": "Usage is recorded, but nothing is charged.",
  "billing.loadError": "Could not load usage settings: {message}",
  "billing.usage.title": "Usage",
  "billing.usage.subtitle": "Provider-neutral usage events for this Workspace.",
  "billing.usage.load": "Load usage",
  "billing.usage.more": "Load more",
  "billing.usage.openHint": "Open usage history to load recent entries.",
  "billing.usage.moreAvailable": "Showing the most recent usage entries.",
  "billing.usage.loading": "Loading usage...",
  "billing.usage.error": "Could not load usage: {message}",
  "billing.usage.empty": "No usage yet.",
  "billing.usage.kind": "Kind",
  "billing.usage.time": "Time",
  "billing.usage.kind.runnerMinute": "Runner time",
  "billing.usage.kind.operation": "Service operation",
  "billing.usage.kind.compute": "Compute",
  "billing.usage.kind.storage": "Storage",
  "billing.usage.quantity": "Quantity",
  "billing.usage.amount": "Estimated amount",
  "billing.usage.unrated": "Unrated",
};
