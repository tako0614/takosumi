/**
 * Installer domain — manages Installation lifecycle.
 *
 * Wave 5 stub. The installer pipeline orchestrates:
 *   1. source fetch (git/local/catalog/bundle)
 *   2. .takosumi.yml parse (delegates to @takos/takosumi-installer)
 *   3. AppSpec validation (5-phase, structural)
 *   4. use-edge resolution + secret materialization
 *   5. component.build execution
 *   6. provider apply (topological)
 *   7. Installation + Deployment persistence
 *
 * Future commits will replace this stub with real implementation that
 * the installer_public_routes handler calls.
 */

import type {
  Deployment,
  Installation,
  InstallationApplyRequest,
  InstallationApplyResponse,
  InstallationDryRunRequest,
  InstallationDryRunResponse,
  RollbackRequest,
  RollbackResponse,
} from "takosumi-contract/installer-api";

export interface InstallerPipelineDependencies {
  // future: SourceFetcher, AppSpecParser, ProviderRegistry,
  // InstallationStore, DeploymentStore, BindingResolver, BuildRunner,
  // observability sinks, etc.
  readonly _placeholder?: never;
}

export class InstallerPipeline {
  constructor(_dependencies: InstallerPipelineDependencies = {}) {
    // Wave 5 stub — no-op until pipeline lands.
  }

  installationDryRun(
    _request: InstallationDryRunRequest,
  ): Promise<InstallationDryRunResponse> {
    throw new Error("InstallerPipeline.installationDryRun not implemented");
  }

  installationApply(
    _request: InstallationApplyRequest,
  ): Promise<InstallationApplyResponse> {
    throw new Error("InstallerPipeline.installationApply not implemented");
  }

  deploymentApply(
    _installationId: string,
    _request: { source?: unknown; expected?: unknown },
  ): Promise<{ deployment: Deployment }> {
    throw new Error("InstallerPipeline.deploymentApply not implemented");
  }

  rollback(
    _installationId: string,
    _request: RollbackRequest,
  ): Promise<RollbackResponse> {
    throw new Error("InstallerPipeline.rollback not implemented");
  }

  listInstallations(_spaceId?: string): Promise<readonly Installation[]> {
    throw new Error("InstallerPipeline.listInstallations not implemented");
  }
}
