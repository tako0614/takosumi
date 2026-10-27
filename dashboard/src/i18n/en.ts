import type { ja } from "./ja.ts";

/**
 * English dictionary. The `Record<keyof typeof ja, string>` constraint makes
 * `ja.ts` the single source of truth for the key set — a missing or extra key
 * here is a type error, so the locales cannot drift.
 */
export const en: Record<keyof typeof ja, string> = {
  "installStore.title": "Install an app",
  "installStore.browseTitle": "Find apps",
  "installStore.manual": "Install from a Git repository",
  "installStore.back": "Choose again",
  "installStore.provenance": "Source and version",
  "installStore.startHint": "Nothing is created in your cloud yet. Install reads the Git version and shows what this app will create, the connections it needs and its settings. You can stop at any point.",
  "installStore.sourceRefStable": "Latest stable version",
  "installStore.sourceRefStableHint": "Leave empty to use the latest stable release.",
  "installStore.sheetTitle": "What this install does",
  "installStore.sheetHint": "What this app will create in your cloud, and the connections and settings it needs. Nothing is created in your cloud until you choose Allow and install.",
  "installStore.plannedTitle": "What this app will create (planned)",
  "installStore.plannedHint": "Once connections and settings are complete, Review shows the exact list and a cost estimate.",
  "installStore.plannedEmpty": "No resources can be counted in advance. Review shows exactly what will be created.",
  "installStore.plannedNotAllowed": "Not allowed by policy",
  "installStore.nameHint": "The name that tells this app apart in your workspace. Use lowercase letters, numbers and hyphens.",
  "installStore.connectionReady": "Connected",
  "installStore.connectionMissing": "Not connected",
  "installStore.connectionNotAllowed": "This app's policy doesn't allow this connection. Choose another one or connect another account.",
  "installStore.addConnection": "Connect another account",
  "installStore.connectionTechnical": "Technical details",
  "installStore.reviewChanges": "Review",
  "installStore.discard": "Stop installing",
  "installStore.discardUnavailable": "The unfinished install couldn't be cleaned up. Check its status in your apps.",
  "installStore.allowInstall": "Allow and install",
  "installStore.costTitle": "Cost estimate",
  "installStore.costRatedZero": "The estimate is {amount}.",
  "installStore.costNotApplicable": "Takosumi doesn't calculate costs in this workspace. Each cloud's own pricing applies to the resources it creates.",
  "run.cost.unavailable": "Couldn't load the cost estimate. Treat the cost as unknown.",
  "installStore.moduleTitle": "Choose a module",
  "installStore.moduleHint":
    "Choose which module from this repository version to install. Each entry ends with the providers it needs.",
  "installStore.moduleOption": "{path} — {providers}",
  "installStore.moduleNoProviders": "No providers",
  "installStore.moduleChoose": "Module directory",
  "installStore.moduleConfirm": "Continue with this module",
  "installStore.moduleUnavailable":
    "Takosumi couldn't safely identify the modules in this repository version.",
  "installStore.moduleMissing":
    "No installable module was found in this repository version.",
  "installStore.moduleRequirements": "Provider details",
  "installStore.sourceSummary": "Configuration and connections",
  "installStore.selectedModule": "Configuration",
  "installStore.sourceScope": "Repository subtree",
  "installStore.detectedProviders": "Providers in this module",
  "installStore.noProviderPackages": "No provider packages were detected in this module.",
  "installStore.requiredConnections": "Required connections",
  "installStore.noRequiredConnections": "This module does not require a provider connection.",
  "installStore.connectionNotSelected": "Not selected",
  "installStore.moduleRequirement":
    "{source} · module {module}{alias} {version}",
  "installStore.stepReview": "Review",
  "installStore.name": "App name",
  "installStore.sourceDetails": "Source and version",
  "installStore.sourceUrl": "Git URL",
  "installStore.sourceRef": "Version (tag, branch or commit; optional)",
  "installStore.sourcePath": "Repository subtree (optional)",
  "installStore.modulePath": "Module folder (optional)",
  "installStore.sourceAuth": "Git connection",
  "installStore.publicSource": "Public repository",
  "installStore.selectValue": "Choose…",
  "installStore.yes": "Yes",
  "installStore.no": "No",
  "installStore.viewApps": "Browse apps",
  "installStore.installedNeedsAttention": "This app is installed but needs attention. Check its state in Manage app.",
  "installStore.refreshLaunch": "Refresh launch URL",
  "installStore.selectWorkspace": "Select a workspace to view this installation.",
  "installStore.noLogs": "No logs yet.",
  "installStore.closePanel": "Close",
  "installStore.needsAttentionTitle": "Needs attention",
  "installStore.uninstall": "Uninstall",
  "installStore.manageConnections": "Manage connections",
  "installStore.manageApp": "Manage app",
  "installStore.cloudConnection": "Cloud connection",
  "installStore.cloudConnected": "Connected. Ready to install.",
  "installStore.closeConnections": "Back to settings",
  "installStore.advancedSettings": "Advanced settings",
  "installStore.appDescription": "Install this app in your workspace with just the settings it needs.",
  "installStore.noLaunchUrl": "This app has no published launch URL. You can view its state in Manage app.",
  "installStore.uninstalling": "Uninstall scheduled",
  "installStore.uninstalled": "Uninstalled",
  "installStore.logs": "Progress and logs",
  "installStore.retryInstall": "Retry installation",
  "installStore.applyUnconfirmed": "The execution could not be confirmed. Check the existing run before starting another execution.",
  "installStore.preparing": "Getting the install ready",
  "installStore.preparingFetching":
    "Fetching the repository. The first time can take about a minute.",
  "installStore.preparingWorkspace": "Confirming the selected workspace.",
  "installStore.preparingConnections": "Reading available connections.",
  "installStore.preparingSource": "Fetching the repository contents.",
  "installStore.preparingCompatibility":
    "Checking that this app can be installed here.",
  "installStore.preparingConfig": "Preparing the app's settings.",
  "installStore.preparingPlan": "Preparing the changes for review.",
  "installStore.preparingTimeout":
    "Preparation took too long. Nothing was created in your cloud, but we couldn't confirm whether the repository was registered. Check it before trying again.",
  "installStore.sourceRegistrationUnconfirmed":
    "Nothing was created in your cloud. We couldn't confirm the repository was registered. Choose Install again to check this same attempt; it won't register the repository twice.",
  "installStore.sourceBaselineUnavailable":
    "Nothing was created in your cloud. The repository list was temporarily unavailable, so registration didn't start. Wait a moment, then choose Install again.",
  "installStore.sourceAutoSyncFailed":
    "Automatic source updates could not be enabled. Retry to enable them for this app.",
  "installStore.providerHint":
    "Connect the cloud this app needs before installing.",
  "installStore.chooseConnection": "Choose a Host / account",
  "installStore.destination": "Host / account",
  "installStore.destinationSummary": "Host / account: {destination}",
  "installStore.providerModule": "Provider / module",
  "installStore.connect": "Connect",
  "installStore.continue": "Continue",
  "installStore.setupTitle": "Settings",
  "installStore.sourceBuildTitle": "Repository build steps",
  "installStore.sourceBuildHint":
    "Check these credential-free commands and produced paths before reviewing changes.",
  "installStore.sourceBuildCommand": "Command {index}",
  "installStore.sourceBuildWorkingDirectory": "Working directory",
  "installStore.sourceBuildSourceRoot": "Repository root",
  "installStore.sourceBuildOutputs": "Produced paths",
  "installStore.setupUnavailableTitle": "Can't show this app's settings",
  "installStore.secretSetupUnavailableTitle": "Secret setup is unavailable",
  "installStore.optionalFeatures": "Optional features",
  "installStore.sourceBuildArguments": "Command arguments",
  "installStore.setupInvalid": "This app's settings definition is invalid.",
  "installStore.setupRequired": "Enter {label}.",
  "installStore.secretUnavailable": "Configure this secret as a connection.",
  "installStore.reviewing": "Reviewing changes",
  "installStore.reviewingHint": "Checking the changes before installing.",
  "installStore.reviewTitle": "What this app will create in your cloud",
  "installStore.reviewHint": "When it looks right, apply it with Allow and install. Nothing is created in your cloud before that.",
  "installStore.reviewReady": "Ready to review",
  "installStore.changes": "Changes",
  "installStore.createCount": "Create",
  "installStore.updateCount": "Change",
  "installStore.deleteCount": "Delete",
  "installStore.approve": "Approve this change",
  "installStore.confirmTitle": "These changes need confirmation",
  "installStore.confirmHint":
    "These changes include a deletion or another change that needs your confirmation.",
  "installStore.confirm": "I reviewed these changes",
  "installStore.install": "Install",
  "installStore.runDetails": "Technical details",
  "installStore.installing": "Installing",
  "installStore.installingHint":
    "Your app is being installed in the background. Return here to check its progress.",
  "installStore.planBlocked": "This can't be installed",
  "installStore.planBlockedHint": "Check the policy or the change details.",
  "installStore.readinessFailed":
    "The app's readiness could not be checked. Open the technical details for more information.",
  "installStore.activationFailed":
    "Activating the app failed. Open the technical details for more information.",
  "installStore.finalizing": "Getting the app ready",
  "installStore.finalizingHint":
    "Waiting for the app's launch link to become available.",
  "installStore.launchNotReady":
    "The app was applied, but its launch link is not ready yet. Retry the check or open the app's management page.",
  "installStore.runFailed": "The app could not be installed",
  "installStore.restartWithLatestSource": "Start again from the latest source",
  "installStore.restartConfirmTitle": "Start again from the latest source?",
  "installStore.restartConfirmMessage":
    "Takosumi will discard the unapplied app and fetch the repository again with the same name. The failed review stays in the history.",
  "installStore.restartUnavailable":
    "Takosumi could not safely discard the unapplied app, so it did not start again. Open the technical details for more information.",
  "installStore.doneTitle": "Installed",
  "installStore.open": "Open",
  "installStore.chooseAnother": "Find another app",
  "installStore.invalidSource": "Enter a valid HTTPS Git URL.",
  "installStore.invalidName":
    "Use lowercase letters, numbers, and hyphens for the app name.",
  "installStore.planMissing": "We couldn't confirm that the review started.",
  "installStore.listingUnavailable":
    "This app is no longer available from the Store.",
  // --- common -------------------------------------------------------------
  "common.loading": "Loading…",
  "common.retry": "Retry",
  "common.refresh": "Refresh",
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

  // --- nav / shell ----------------------------------------------------------
  "nav.home": "Home",
  "nav.store": "Store",
  "nav.app": "App",
  "nav.runs": "History",
  "nav.connections": "Connections",
  "nav.primary": "Main menu",
  "nav.notifications": "Notifications",
  "nav.account": "Account",
  "nav.docs": "Docs",
  "nav.backToTakos": "Back to Takos",
  "nav.deployContext": "Apps",
  "shell.skipToContent": "Skip to content",
  "shell.userMenu": "User menu",
  "shell.signOut": "Sign out",
  "shell.language": "Language",
  "shell.theme": "Appearance",
  "shell.notificationsAria": "Notifications ({n} needing attention)",
  "theme.system": "System",
  "theme.light": "Light",
  "theme.dark": "Dark",

  // --- workspaces (スペース in the Japanese UI) -----------------------------------
  "workspace.selectMessage": "Choose which workspace this belongs to.",
  "workspace.defaultName": "Personal",
  "workspace.start.aria": "Start a workspace",
  "workspace.start.kicker": "Getting started",
  "workspace.start.title": "Create a workspace for your apps",
  "workspace.start.body":
    "A workspace keeps your apps, connections, history and usage together. It's yours alone to start.",
  "workspace.start.create": "Create a workspace",
  "workspace.start.creating": "Creating…",
  "workspace.label": "Workspaces",
  "workspace.switcherAria": "Switch workspace (current: {name})",
  "workspace.loading": "Loading…",
  "workspace.loadFailed": "Couldn't load workspaces — {message}",
  "workspace.settings": "Workspace settings",
  "workspace.unnamed": "Unnamed workspace",
  "workspace.createdOn": "Created {date}",
  "workspace.scopeNote": "Workspace: {name}",
  "workspace.noneTitle": "No workspace yet",
  "workspace.noneMessage": "Start from Home and this page becomes available.",
  "workspace.noneCta": "Go to Home",
  "workspace.create.environment": "Separate an environment",
  "workspace.create.environmentBody":
    "Keep apps and connections apart, such as production and testing.",
  "workspace.create.team": "Use with a team",
  "workspace.create.teamBody": "Invite people and share apps and connections.",
  "workspace.create.environmentNameLabel": "Environment name",
  "workspace.create.teamNameLabel": "Team name",
  "workspace.create.environmentPlaceholder": "e.g. Testing, Experiments",
  "workspace.create.teamPlaceholder": "e.g. Design team, Client A",
  "workspace.create.environmentHelp":
    "You switch to the new workspace when it's created. It's yours alone to start.",
  "workspace.create.teamHelp":
    "After creating it, you continue to inviting members.",
  "workspace.create.submit": "Create",
  "workspace.create.failed": "Couldn't create the workspace — {message}",
  "workspace.create.done": "Created “{name}” and switched to it.",
  "workspace.thisWorkspace": "This workspace",
  "workspace.name": "Name",
  "workspace.nameHint": "The name members and the workspace switcher show.",
  "workspace.nameRequired": "Enter a name.",
  "workspace.saved": "Name saved.",
  "workspace.notFound":
    "This workspace wasn't found. Switch workspaces, or restore it from Archived below.",
  "workspace.createdLabel": "Created",
  "workspace.new.title": "Add a workspace",
  "workspace.new.body": "Pick what it's for, and a workspace is created for it.",
  "workspace.archive.title": "Archive this workspace",
  "workspace.archive.body":
    "It leaves the workspace switcher. Apps, connections, history and usage keep running and are not deleted. Restore it from Archived below.",
  "workspace.archive.lastWorkspace": "Your last workspace can't be archived.",
  "workspace.archive.cta": "Archive",
  "workspace.archive.confirmTitle": "Archive “{name}”",
  "workspace.archive.confirmMessage":
    "It only leaves the workspace switcher. Its apps keep running, and its connections, history and usage stay. You can restore it any time.",
  "workspace.archive.done": "Archived “{name}”. Its apps keep running.",
  "workspace.archived.title": "Archived workspaces",
  "workspace.archived.body": "Restoring brings a workspace back to the switcher.",
  "workspace.archived.restore": "Restore",

  // --- auth -----------------------------------------------------------------
  "auth.signIn": "Sign in",
  "legal.policiesNav": "Operator policies",
  "auth.signInSub": "Sign in to open your apps and settings.",
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
  "auth.installContextAria": "App to continue after sign-in",
  "auth.installContextKicker": "App to install",
  "auth.installSignInTitle": "Sign in to continue installing",
  "auth.installSignInSub":
    "After signing in you return to installing {name}. Signing in does not install it yet.",
  "auth.installContextTitle": "Continue after sign-in",
  "auth.installContextRef": "version {ref}",
  "auth.installContextDefaultRef": "default version",
  "auth.installContextRootPath": "folder found when installing",
  "auth.termsPrefix": "By continuing, you agree to the ",
  "auth.termsOfService": "Terms of Service",
  "auth.and": " and ",
  "auth.privacyPolicy": "Privacy Policy",
  "auth.termsSuffix": ".",
  "auth.startFailed":
    "Couldn't start sign-in. Try again.",
  "auth.startInsecureContext":
    "Sign-in can't start over this connection. Open the dashboard over HTTPS (or on localhost).",
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
  "error.planReconcileTimeout":
    "We stopped waiting for the changes to be ready for review. It may still be running; check Deploy history before starting again.",
  "errorBoundary.title": "Something went wrong",
  "errorBoundary.body":
    "An unexpected error stopped this page from loading. Please reload the page.",
  "errorBoundary.routeTitle":
    "This page couldn't be shown",
  "errorBoundary.routeBody":
    "An unexpected error stopped this page. The rest of the dashboard still works; try again or reload the page.",
  "errorBoundary.tryAgain": "Try again",
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
  "status.capsule.uninstalled": "Scheduled for deletion",
  "status.capsule.destroyed": "Deleted",
  "status.run.queued": "Queued",
  "status.run.running": "Running",
  "status.run.waiting_approval": "Waiting for approval",
  "status.run.succeeded": "Succeeded",
  "status.run.failed": "Failed",
  "status.run.cancelled": "Cancelled",
  "status.run.expired": "Expired",
  "status.run.ready_to_deploy": "Ready to deploy",
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
  "op.state_recovery": "State recovery",
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
  "app.notFound": "Service not found",
  "app.backToList": "Back to list",
  "app.loadFailedTitle": "Couldn't load this service",
  "app.refreshFailed":
    "Couldn't fetch the latest state — showing the last loaded version.",
  "app.notFoundMessage": "It may have been deleted, or the link may be wrong.",
  "app.surfaces.title": "Public links",
  "app.surfaces.details": "URLs and access information",
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
  "app.surfaces.open": "Open app",
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
    "Choose a Git branch, tag, or commit before reviewing changes.",
  "app.deploys.sourceVersionCurrent": "Tracked version",
  "app.deploys.sourceVersionChange": "Change version",
  "app.deploys.sourceVersionInput": "Git ref",
  "app.deploys.sourceVersionHint":
    "Enter a branch, tag, or commit for this workload, then review before deploying.",
  "app.deploys.sourceVersionApply": "Review this version",
  "app.deploys.sourceVersionUnavailable":
    "The applied source version is unavailable.",
  "app.deploys.empty": "No deploys yet.",
  "app.deploys.generationBadge": "Version {n}",
  "app.deploys.restore": "Restore this state",
  "app.deploys.restoreDisclosure": "Restore a previous version",
  "app.deploys.advancedActions": "Extra actions",
  "app.deploys.advancedActionsBody":
    "Exports selected workspace management records. This export cannot be imported or used to restore a service.",
  "app.deploys.backup": "Create partial export",
  "app.deploys.backupCreated":
    "Partial export created. This export cannot be imported or used to restore a service.",
  "app.deploys.backupSupportRef": "Export ID",
  "app.deploys.inventoryTitle": "Deployed resources",
  "app.deploys.inventoryRecordedNote":
    "Recorded in the current applied state; this is not live health.",
  "app.deploys.inventoryRecoveryUnknownTitle": "Resources after state recovery",
  "app.deploys.inventoryRecoveryUnknownNote":
    "Only state data was adopted. The original deploy remains failed; resource existence and provider-operation success have not been verified.",
  "app.deploys.inventoryLoadError":
    "The recorded resource inventory could not be loaded.",
  "app.deploys.inventoryLegacyUnavailable":
    "This older applied state has no resource inventory record.",
  "app.deploys.inventoryGeneration": "Version number",
  "app.deploys.inventoryRecordedAt": "Recorded",
  "app.deploys.inventoryStateVersion": "State version",
  "app.deploys.inventoryApplyRun": "Deploy",
  "app.deploys.inventoryPlanRun": "Review",
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
  "app.config.internalNames": "Setting reference names",
  "app.config.subtitle":
    "Review your changes before applying them. Nothing is applied here.",
  "app.config.publicUrl": "Public URL",
  "app.config.subdomain": "Public subdomain",
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
  "app.config.resetPendingHint": "Reverts to the default in the reviewed change.",
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
  "app.uninstall.title": "Schedule deletion",
  "app.uninstall.body":
    "{name} and its data stay for a grace period, and you can cancel until then. When it ends, a copy of the data is exported where this server supports it, and then the service is deleted.",
  "app.uninstall.cta": "Schedule deletion",
  "app.uninstall.confirmTitle": "Schedule deletion of this service?",
  "app.uninstall.confirmMessage":
    "{name} keeps running and keeps its data until the grace period ends. Then a data export is attempted and the service is deleted for good. You can cancel until then.",
  "app.uninstall.dependencyWarning":
    "Other services ({services}) depend on {name}. Deleting it may disrupt them.",
  "app.uninstall.dependencyCheckLoading": "Checking connected services before deletion…",
  "app.uninstall.dependencyCheckFailed":
    "Connected services could not be checked. Review dependencies before deletion.",
  "app.uninstall.immediateTitle": "Delete now",
  "app.uninstall.banner":
    "{name} will be deleted on {date}. Its data stays until then, and you can cancel.",
  "app.uninstall.bannerDue":
    "The grace period for {name} has ended. Deletion will run shortly.",
  "app.uninstall.bannerDestroying": "{name} is being deleted.",
  "app.uninstall.bannerBlocked":
    "Automatic deletion of {name} stopped because the deletion could not be confirmed as safe. Cancel it, or delete the service now from Settings.",
  "app.uninstall.exportExported": "The data was exported before deletion.",
  "app.uninstall.exportExportedLedgerOnly":
    "The service settings and state were exported before deletion. This app does not declare an export of its own data.",
  "app.uninstall.bannerFailed":
    "Deleting {name} did not finish. Delete it now from Settings to try again.",
  "app.uninstall.exportFailed":
    "Exporting the data before deletion failed. Deletion continues.",
  "app.uninstall.exportSkipped":
    "This server cannot export the data, so no export was made.",
  "app.uninstall.cancel": "Cancel deletion",
  "app.uninstall.deleteNow": "Delete now",
  "app.setupIncomplete.body":
    "Setup didn't finish. Retry from the update review, or delete this service in Settings and start over.",
  "app.setupIncomplete.review": "Open updates",
  "app.setupIncomplete.initialReviewBody": "This service's first review is waiting. Open it to finish setup; starting an update review won't resume it.",
  "app.setupIncomplete.openInitialReview": "Open initial review",
  "app.setupIncomplete.loadingInitialReview": "Finding the initial review…",
  "app.setupIncomplete.initialReviewUnavailable": "We couldn't find this service's first review. Reopen the original add link if you have it; otherwise contact your operator. Don't use an update review instead.",
  "installStore.recoveryUnverified": "Couldn't check how the install is going",
  "installStore.recoveryUnverifiedHint": "The original install may still be running. Check again or look at the history before installing it again.",
  "installStore.recoveryContinue": "You can continue this install",
  "installStore.recoveryContinueHint": "One more step is needed. Continuing only prepares the changes for review; nothing is applied.",
  "installStore.recoveryReview": "The first review is ready",
  "installStore.recoveryReviewHint": "Open the first review to check it. Applying it is a separate step.",
  "installStore.recoveryFailed": "The install stopped",
  "installStore.recoveryFailedHint": "No review is available from this record. Partial setup may not have been undone; check your apps or ask your operator before installing it again.",
  "installStore.recoveryFailedRun": "The install stopped; the review is available",
  "installStore.recoveryFailedRunHint": "Open the recorded review to see what happened, and choose a retry yourself if one is offered. Nothing retries or applies automatically.",

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
  "run.summary.stateRecoverySucceeded":
    "State data recovered. This does not mean the deploy succeeded.",
  "run.summary.stateRecoverySucceededHint":
    "The original deploy remains failed. Resource and provider-operation outcomes are unknown, and service availability has not been confirmed.",
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
  "run.summary.removing": "Deleting…",
  "run.summary.removed": "Deletion complete.",
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
    "Choose a Git branch, tag, or commit before reviewing changes.",
  "controlError.compatibilityStale":
    "The check result is out of date. Check again.",
  "controlError.runnerUnavailable":
    "The run environment isn't available right now. Try again in a moment.",
  "controlError.sourceSyncPending":
    "The repository contents are still being fetched. Wait a moment and try again.",
  "controlError.planFailed":
    "The changes couldn't be prepared for review. Check Deploy history, then try again.",
  "controlError.slotLimitReached":
    "You've reached your limit. Delete a service you no longer need, or contact your operator.",
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
  "run.restartLatestSource": "Start over with the latest source",
  "run.restartLatestSourceConfirm.title": "Start over with the latest source?",
  "run.restartLatestSourceConfirm.message":
    "“{name}” has never been deployed. This abandons the incomplete service, removes its old pinned source selection, and fetches the latest contents. The failed change-review history is preserved.",
  "run.restartLatestSourceUnavailable":
    "This service cannot be safely rebuilt from here. Reload its status and try again.",
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

  // --- add flow (/new) -------------------------------------------------------
  "new.git.defaultRef": "Git default branch",
  "new.compat.ready": "Can be added as is",
  "new.compat.patch": "Needs manual changes",
  "new.compat.unsupported": "Cannot be added right now",
  "new.compat.summary.checkFailed":
    "The pre-add check couldn't finish. This isn't necessarily a problem with the service — try again.",
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
    "Choose another version or ask the app publisher to update .well-known/takosumi.json. Takosumi won't guess the setup fields for you.",
  "new.compat.issue.providerPreserved.message":
    "The repository's non-secret {provider} configuration will be preserved.",
  "new.compat.issue.backendIsolated.message":
    "The repository's own storage settings are kept; Takosumi keeps this service's deployment records separately.",
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
  "new.error.connectionRequired":
    "Publishing this service needs a connected cloud account. Set up the connection, then try again.",
  "new.error.alreadyExistsGeneric":
    "This service is already added. Open the existing service instead of creating another one.",

  // --- members ---------------------------------------------------------------
  "members.role.owner": "Owner",
  "members.role.admin": "Admin",
  "members.role.member": "Member",
  "members.role.viewer": "Viewer",
  "members.title": "Members",
  "members.subtitle": "People who use this workspace with you.",
  "members.listLabel": "Member list",
  "members.roleHelp.owner":
    "Manages everything, including changing and removing members.",
  "members.roleHelp.admin":
    "Installs, updates and uninstalls apps, manages connections, and invites members.",
  "members.roleHelp.member":
    "Opens and uses apps. Can't install apps or change settings.",
  "members.roleHelp.viewer":
    "Sees apps and their state. Apps are told this person is a viewer.",
  "members.unnamed": "Member ({id})",
  "members.loadFailedTitle": "Couldn't load members",
  "members.invite.open": "Invite a member",
  "members.removeTitle": "Remove “{name}” from this workspace",
  "members.status.active": "Active",
  "members.status.invited": "Invited",
  "members.status.suspended": "Suspended",
  "members.invite.subtitle":
    "Enter the email of someone who has signed in to Takosumi once. They get access right away — no email is sent.",
  "members.invite.email": "Email",
  "members.invite.role": "Role",
  "members.invite.cta": "Invite",
  "members.invite.notFound":
    "No Takosumi account was found for that email. Ask them to sign in once first.",
  "members.invite.emailRequired": "Enter an email address.",
  "members.invite.success": "Invited {email}. They have access now.",
  "members.you": "you",
  "members.changeRole": "Change role",
  "members.roleSelectLabel": "Role for {name}",
  "members.roleChangeConfirmTitle": "Change role",
  "members.roleChangeConfirmMessage": "Change the role of {name} to “{role}”?",
  "members.lastOwnerDemote":
    "The last owner cannot be demoted. Appoint another owner first.",
  "members.lastOwnerRemove":
    "The last owner can't be removed. Appoint another owner first.",
  "members.remove": "Remove",
  "members.removeSelf": "Leave this workspace",
  "members.removeSelfConfirm":
    "You'll leave this workspace and lose access to its apps and connections. You can't rejoin on your own.",
  "members.removeConfirm":
    "{name} loses access to this workspace's apps and connections. Installed apps keep running. Invite them again to restore access.",
  "members.empty": "No members yet.",
  "members.viewerNote":
    "Owners and admins invite members and change or remove them.",

  // --- connections -------------------------------------------------------------
  "conn.subtitle":
    "The connections your apps use to create resources in your cloud. Each one shows the apps that use it.",
  "conn.title": "Connections",
  "conn.footnote":
    "To switch the connection an app uses, open the app and choose it in its settings.",
  "conn.operatorProvided": "Provided by the operator",
  "conn.apps.label": "Used by",
  "conn.apps.loading": "Checking…",
  "conn.apps.none": "No app uses it yet",
  "conn.apps.unknown": "Couldn't check which apps use it",
  "conn.oauth.accountSettingsHint":
    "Optional. Fill it in to limit the connection to one account.",
  "conn.add.displayNameHint": "Helps tell connections to the same cloud apart.",
  "conn.byok.unavailable":
    "Clouds that aren't listed can't be connected here. Check with the operator.",
  "conn.genericEnv.providerHint":
    "The cloud name an app's install screen shows (for example cloudflare/cloudflare).",
  "conn.genericEnv.removeRow": "Remove this row",
  "conn.remove.cta": "Remove",
  "conn.remove.confirm": "Remove",
  "conn.remove.affectsApps":
    "These apps use this connection: {apps}. Their next update, settings change or uninstall needs another connection.",
  "conn.remove.noApps": "No app uses this connection.",
  "conn.remove.appsUnknown":
    "Which apps use it couldn't be checked. Any app that does will need another connection for its next update, settings change or uninstall.",
  "conn.remove.keepsResources":
    "The saved keys are deleted and can't be recovered. Resources your apps created are not deleted.",
  "conn.expiresAt": "Expires: {date}",
  "conn.oauth.manual": "Connect with a key instead",
  "conn.oauth.connected": "Connection saved.",
  "conn.oauth.connect": "Connect {provider}",
  "conn.oauth.waiting": "Authorize access in the provider window. Your app settings stay here.",
  "conn.oauth.retryHint":
    "Connection was not completed. Check that the authorization window can open and try again, or enter a key below.",
  "conn.oauth.failed": "Connection failed. Please try again.",
  "conn.oauth.error.missingCode":
    "The authorization response was incomplete. Please try again.",
  "conn.oauth.error.forbidden":
    "You can't add connections to this workspace. Ask an owner or admin.",
  "conn.oauth.error.oauthFailed":
    "Authentication with the provider failed. Please wait a moment and try again.",
  "conn.oauth.errorCode": "Error code: {code}",
  "conn.return.title": "Back to installing “{name}”",
  "conn.return.subtitle":
    "Save the connection, then return to finish installing.",
  "conn.return.cta": "Back to install",
  "conn.saved.message": "Saved {name}.",
  "conn.saved.needsTest":
    "Saved {name}. Test the connection before going back to the install.",
  "conn.saved.testCta": "Test connection",
  "conn.saved.returnCta": "Back to install",
  "conn.add.provider": "Cloud to connect",
  "conn.add.genericEnvOption": "Connect a cloud that isn't listed",
  "conn.add.title": "Connect account",
  "conn.add.open": "Add a connection",
  "conn.add.close": "Close",
  "conn.add.displayName": "Connection name (optional)",
  "conn.add.displayNamePlaceholder": "e.g. Production",
  "conn.guided.openProvider": "Open {provider} access page",
  "conn.byok.title": "Connect a cloud with its keys",
  "conn.byok.body":
    "This cloud has no guided way to connect. Enter the keys you created in the cloud's console, under the names it expects.",
  "conn.byok.noBillingNote":
    "Any Takosumi charge appears when you review an install. The cloud bills its own charges.",
  "conn.byok.usePreset": "Choose from the list",
  "conn.register": "Save connection",
  "conn.registering": "Saving…",
  "conn.genericEnv.providerName": "Cloud",
  "conn.genericEnv.providerPlaceholder": "cloudflare/cloudflare",
  "conn.genericEnv.envName": "Key name",
  "conn.genericEnv.envNamePlaceholder": "e.g. CLOUDFLARE_API_TOKEN",
  "conn.genericEnv.value": "Key value",
  "conn.genericEnv.valuePlaceholder": "Paste the value",
  "conn.genericEnv.addRow": "Add another key",
  "conn.genericEnv.providerRequired": "Enter the cloud's name.",
  "conn.genericEnv.nameRequired": "A row with a value needs a key name.",
  "conn.genericEnv.invalidName":
    "“{name}” can't be a key name. Use an uppercase name like CLOUDFLARE_API_TOKEN.",
  "conn.genericEnv.reservedName":
    "“{name}” is used by Takosumi itself. Use the cloud's own name.",
  "conn.genericEnv.duplicateName": "“{name}” is already added.",
  "conn.genericEnv.oneRequired": "Enter at least one key.",
  "conn.error.invalidProvider": "This cloud can't be connected from here.",
  "conn.error.fieldRequired": "{field} is required.",
  "conn.empty.title": "No cloud connected yet",
  "conn.empty.message":
    "Apps create their resources in the clouds you connect here. Choosing an app in the store also walks you through the connections it needs.",
  "conn.test": "Test connection",
  "conn.testing": "Checking…",
  "conn.test.notReady": "This connection isn't ready yet (status: {status}).",
  "conn.remove.confirmTitle": "Remove “{name}”",

  // --- notifications -------------------------------------------------------------
  "notif.markAllRead": "Mark all as read",
  "notif.title": "Notifications",
  "notif.subtitle": "Installs, updates, failures — what happened most recently.",
  "notif.empty.title": "No notifications yet",
  "notif.empty.message": "Events appear here when you install or update apps.",
  "notif.empty.cta": "Find apps in the store",
  "notif.attention": "Events needing attention: {n}",
  "notif.badge.attention": "Attention",
  "notif.event.installCreated": "Started installing “{name}”",
  "notif.event.installCreatedEnv": "Environment: {env}",
  "notif.event.planReady": "{operation} is ready",
  "notif.event.planReadyNamed": "{operation} for “{name}” is ready",
  "notif.event.planReadyDetail": "Review the contents and approve",
  "notif.event.planBlockedDetail": "Approval is blocked by policy",
  "notif.event.approved": "Approved {operation}",
  "notif.event.approvedNamed": "Approved {operation} for “{name}”",
  "notif.event.applied": "Applied app changes",
  "notif.event.appliedNamed": "Applied changes to “{name}”",
  "notif.event.appliedDetail": "Updated values: {n}",
  "notif.event.destroyed": "Uninstalled an app",
  "notif.event.destroyedNamed": "Uninstalled “{name}”",
  "notif.event.failed": "{operation} failed",
  "notif.event.failedNamed": "{operation} for “{name}” failed",
  "notif.event.drift": "An app's cloud state differs from its record",
  "notif.event.driftNamed":
    "The cloud state of “{name}” differs from its record",
  "notif.event.driftDetail":
    "The live state may have drifted from its settings",
  "notif.event.stale": "An app this one uses changed — an update is available",
  "notif.event.staleNamed":
    "An app it uses changed — an update is available for “{name}”",
  "notif.event.staleDetail": "Updated by: {producer}",
  "notif.event.staleSource": "A new version of this app is available",
  "notif.event.staleSourceNamed": "A new version of “{name}” is available",
  "notif.event.connCreated": "Added connection “{provider}”",
  "notif.event.connCreatedGeneric": "Added a connection",
  "notif.event.connRevoked": "Connection “{provider}” was revoked",
  "notif.event.connRevokedGeneric": "A connection was revoked",
  "notif.event.backupCreated": "Exported management data",
  "notif.event.depCreated": "Linked two apps",
  "notif.event.depDeleted": "Unlinked two apps",
  "notif.event.shareRequested":
    "Received a request to share values between workspaces",
  "notif.event.shareApproved": "Approved sharing values between workspaces",
  "notif.event.shareRevoked": "Revoked sharing values between workspaces",
  "notif.event.groupCreated": "Started a grouped update",
  "notif.event.autoUpdateOn": "Automatic updates turned on",
  "notif.event.autoUpdateOff": "Automatic updates turned off",
  "notif.event.autoUpdateFailed": "An automatic update could not finish",
  "notif.event.autoUpdateFailedNamed":
    "An automatic update for “{name}” could not finish",
  "notif.event.autoUpdateFailedDetail": "Review the update on the app's page",
  "notif.event.uninstallScheduled": "Scheduled an app to uninstall",
  "notif.event.uninstallScheduledNamed": "Scheduled “{name}” to uninstall",
  "notif.event.uninstallCancelled": "Cancelled a scheduled uninstall",
  "notif.event.uninstallCancelledNamed":
    "Cancelled the scheduled uninstall of “{name}”",
  "notif.event.uninstallBlocked": "A scheduled uninstall stopped",
  "notif.event.uninstallBlockedNamed":
    "The scheduled uninstall of “{name}” stopped",
  "notif.event.uninstallBlockedDetail":
    "On the app's page, cancel it or uninstall now",
  "notif.event.interfaceDeadLettered": "An app's screen couldn't be set up",
  "notif.event.interfaceDeadLetteredNamed":
    "The screen for “{name}” couldn't be set up",
  "notif.event.interfaceDeadLetteredDetail": "Try again from the app's page",
  "notif.event.interfaceRetryRequested": "Retrying an app's screen setup",
  "notif.event.interfaceRetryRequestedNamed":
    "Retrying the screen setup for “{name}”",
  "notif.event.recorded": "Recorded activity",
  "notif.otherWorkspace": "Other workspace: {name}",

  // --- activity -------------------------------------------------------------------
  "activity.actorYou": "You",
  "activity.actorSystem": "Takosumi (automatic)",

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

  // --- account ---------------------------------------------------------------------
  "account.title": "Account",
  "account.sectionsLabel": "Account sections",
  "account.section.me": "You",
  "account.section.members": "Members",
  "account.section.billing": "Billing & usage",
  "account.section.workspace": "Workspace",
  "account.section.cli": "CLI & API",
  "account.profile.title": "Signed in as",
  "account.profile.displayName": "Name",
  "account.profile.email": "Email",
  "account.profile.notSet": "Not set",
  "account.profile.provider": "Signed in with",
  "account.profile.nameHint":
    "Your name and email come from the account you signed in with. Members of your workspaces see your name; only their owners and admins see your email.",
  "account.language.title": "Language",
  "account.theme.title": "Appearance",
  "account.preferences.title": "Display & language",
  "account.preferences.body":
    "How the dashboard looks and reads in this browser.",
  "account.installTarget.title": "Store install links",
  "account.installTarget.body":
    "Register this browser so a store's Install button opens in this dashboard on this device.",
  "account.installTarget.register": "Register this device",
  "account.installTarget.registered": "Registered on this device",
  "account.installTarget.done": "Registered. Confirm the browser's prompt.",
  "account.installTarget.unsupported":
    "This browser can't register. Enter this dashboard's URL in the store instead.",
  "account.morePages.title": "From the operator",
  "account.signOut.title": "Sign out",
  "account.signOut.body":
    "Signs out of this browser. Other devices stay signed in.",
  "account.signOut.cta": "Sign out of this browser",
  "account.signOut.confirm": "Sign out now?",
  "account.apiKeys.title": "Use from the CLI & API",
  "account.apiKeys.subtitle":
    "Keys that let the Takosumi CLI and your automation act as you. Pass a key to the CLI with --token.",
  "account.apiKeys.apiHelp":
    "To call the API directly, send the same key in an Authorization: Bearer header to /api/v1.",
  "account.apiKeys.secretOnce":
    "A key's value is shown once, right after it's created.",
  "account.apiKeys.name": "Key name",
  "account.apiKeys.namePlaceholder": "For example: Development CLI",
  "account.apiKeys.expiresLabel": "Expires in",
  "account.apiKeys.expiresDays": "{days} days",
  "account.apiKeys.scopes": "Permissions",
  "account.apiKeys.scopesHint":
    "Choose only what this key needs. Administrative access is operator-issued and cannot be created here.",
  "account.apiKeys.scopeCatalog.loading": "Loading available permissions…",
  "account.apiKeys.scopeCatalog.loadFailed":
    "Available permissions could not be loaded. Key creation is disabled until they are available.",
  "account.apiKeys.scopeCatalog.retry": "Retry permissions",
  "account.apiKeys.scopeCatalog.empty":
    "This environment has no permissions that can be granted here.",
  "account.apiKeys.scopeCatalog.workspaceRequired":
    "Create a workspace before making a key with this permission.",
  "account.apiKeys.restrictWorkspace": "Only allow use in the current workspace",
  "account.apiKeys.create": "Create key",
  "account.apiKeys.createSubmit": "Create",
  "account.apiKeys.listLabel": "Your keys",
  "account.apiKeys.created": "API key created",
  "account.apiKeys.createdHint":
    "This value cannot be shown again. Save it somewhere secure now.",
  "account.apiKeys.copy": "Copy",
  "account.apiKeys.copied": "Copied",
  "account.apiKeys.copyFailed":
    "Could not copy the key. Save the visible value manually.",
  "account.apiKeys.error":
    "Could not complete the API key operation: {message}",
  "account.apiKeys.empty": "No keys yet.",
  "account.apiKeys.workspaceBound": "This workspace only",
  "account.apiKeys.lastUsed": "Last used",
  "account.apiKeys.neverUsed": "Never",
  "account.apiKeys.status.active": "Active",
  "account.apiKeys.status.revoked": "Revoked",
  "account.apiKeys.status.expired": "Expired",
  "account.apiKeys.expires": "Until {date}",
  "account.apiKeys.noExpiry": "No expiry",
  "account.apiKeys.revoke": "Revoke",
  "account.apiKeys.revokeConfirm": "Revoke",
  "account.apiKeys.revokeConsequence":
    "Any CLI or automation using this key stops working immediately.",

  // --- billing -------------------------------------------------------------------
  "billing.mode.disabled": "Takosumi doesn't charge for this workspace.",
  "billing.mode.showback":
    "Takosumi records this workspace's usage but doesn't bill it.",
  "billing.loadError": "Couldn't load charges: {message}",
  "billing.title": "Charges",
  "billing.ownersOnly":
    "The workspace's owners and admins can see charges and usage.",
  "billing.cloudCosts":
    "Cloud resources your apps create are billed by each cloud.",
  "billing.usage.quantityLine": "Quantity {quantity}",
  "billing.usage.amountUnknown": "Amount unknown",
  "billing.usage.removedApp": "Removed app",
  "billing.usage.title": "Usage",
  "billing.usage.subtitle": "Usage recorded for this workspace, newest first.",
  "billing.usage.more": "Load more",
  "billing.usage.error": "Couldn't load usage: {message}",
  "billing.usage.empty": "No usage yet.",
  "billing.usage.kind.runner_minute": "Run time",
  "billing.usage.kind.operation": "App operation",
  "billing.usage.kind.compute": "Compute",
  "billing.usage.kind.storage": "Storage",
  "billing.commercial.description":
    "Prepaid credits fund Takosumi usage and do not expire.",
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
  "billing.commercial.account.status.active": "Takosumi usage available",
  "billing.commercial.account.status.trialing": "Takosumi usage available",
  "billing.commercial.account.status.pastDue": "Payment needs attention",
  "billing.commercial.account.status.disabled": "Takosumi usage suspended",
  "billing.commercial.account.blocked.paymentDisputed":
    "New Takosumi usage is blocked while a payment dispute is open. Your visible prepaid credit does not expire. Resolve the dispute in payment settings.",
  "billing.commercial.account.blocked.paymentPastDue":
    "New Takosumi usage is blocked because payment could not be confirmed. Your visible prepaid credit does not expire. Review your payment method.",
  "billing.commercial.account.blocked.disabled":
    "New Takosumi usage is blocked because the billing account is disabled. Your visible prepaid credit does not expire. Review payment settings.",
  "billing.commercial.account.blocked.suspended":
    "New Takosumi usage is blocked while the billing account needs attention. Your visible prepaid credit does not expire. Review payment settings.",
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
    "Charged and reversed wallet usage for this workspace.",
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
