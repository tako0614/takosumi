import type {
  ActorContext,
  Deployment,
  DeploymentStatus,
  GroupHead,
  ProviderObservation,
} from "takosumi-contract/reference/compat";

export type DeploymentMode = "preview" | "resolve" | "apply" | "rollback";

export interface DeploymentExpansionSummary {
  readonly components?: number;
  readonly bindings?: number;
  readonly routes?: number;
  readonly resources?: number;
  readonly [key: string]: unknown;
}

export interface DeploymentEnvelope {
  readonly deployment: Deployment;
  readonly expansion_summary?: DeploymentExpansionSummary;
}

export interface DeploymentMutationResponse {
  readonly deployment_id: string;
  readonly status: DeploymentStatus;
  readonly conditions: Deployment["conditions"];
  readonly expansion_summary?: DeploymentExpansionSummary;
}

export interface ActorRouteInput {
  readonly actor: ActorContext;
}

export interface DeploymentRouteCreateInput extends ActorRouteInput {
  readonly mode: DeploymentMode;
  readonly manifest?: unknown;
  readonly source?: DeploymentRouteSourceInput;
  readonly target_id?: string;
  readonly group?: string;
  readonly env?: string;
  readonly space_id?: string;
}

export type DeploymentRouteSourceInput = DeploymentRouteGitSourceInput;

export interface DeploymentRouteGitSourceInput {
  readonly kind: "git";
  readonly repository_id: string;
  readonly ref: string;
  readonly path?: string;
  readonly manifest_path?: string;
}

export interface DeploymentRouteGetInput extends ActorRouteInput {
  readonly deploymentId: string;
}

export interface DeploymentRouteListInput extends ActorRouteInput {
  readonly group?: string;
  readonly status?: DeploymentStatus;
  readonly space_id?: string;
}

export interface GroupRouteRefInput extends ActorRouteInput {
  readonly groupId: string;
  readonly space_id?: string;
}

export interface GroupRouteRollbackInput extends GroupRouteRefInput {
  readonly target_id?: string;
}

export interface DeploymentRouteApproveInput extends ActorRouteInput {
  readonly deploymentId: string;
  readonly policy_decision_id?: string;
}

export interface DeploymentRouteService {
  resolveDeployment(
    input: DeploymentRouteCreateInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  applyDeployment(
    input: DeploymentRouteCreateInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  previewDeployment(
    input: DeploymentRouteCreateInput,
  ): Promise<DeploymentMutationResponse> | DeploymentMutationResponse;
  applyResolved(
    input: DeploymentRouteGetInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  approveDeployment(
    input: DeploymentRouteApproveInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  rollbackGroup(
    input: GroupRouteRollbackInput,
  ): Promise<DeploymentEnvelope> | DeploymentEnvelope;
  getDeployment(
    input: DeploymentRouteGetInput,
  ): Promise<Deployment | null> | Deployment | null;
  listDeployments(
    input: DeploymentRouteListInput,
  ): Promise<readonly Deployment[]> | readonly Deployment[];
  getGroupHead(
    input: GroupRouteRefInput,
  ): Promise<GroupHead | null> | GroupHead | null;
  listObservations(
    input: DeploymentRouteGetInput,
  ): Promise<readonly ProviderObservation[]> | readonly ProviderObservation[];
}
