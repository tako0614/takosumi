/**
 * Projects domain service (Workspace / Project / Capsule final model).
 *
 * A Project is a Workspace-owned grouping for one product, service,
 * application, or infrastructure group. Capsules live under a Project
 * (`capsules.projectId`); a deterministic default Project is backfilled per
 * Workspace so existing Workspace-direct Capsules keep a stable owner.
 *
 * This service owns Project creation + lookup and the slug-uniqueness invariant
 * within a Workspace. No secret material flows through it.
 *
 * The production composition injects the shared OpenTofu control store, whose
 * D1/Postgres implementations persist this port in the canonical `projects`
 * table. Project creation is deliberately routed through the store's guarded
 * record seam so Workspace management state and slug uniqueness share one
 * durable boundary.
 */

import type { Project } from "takosumi-contract/projects";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type {
  ProjectCreationInput,
  ProjectCreationResult,
  WorkspaceManagement,
  WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";
import { assertWorkspaceManagementAuthorityInput, WorkspaceManagementAdmissionConflictError } from "../deploy-control/store.ts";

/**
 * Deterministic default Project id scoped by its owning Workspace.
 *
 * A single global `prj_default` id lets the first Workspace occupy the id and
 * forces every later Workspace onto a different lookup path. The durable D1/
 * Postgres migration already uses this Workspace-qualified form; the service
 * must use the same identity rule.
 */
export function defaultProjectId(workspaceId: string): string {
  return `prj_default_${workspaceId}`;
}

/** The default per-Workspace Project slug. */
export const DEFAULT_PROJECT_SLUG = "default";

/**
 * Project slug grammar: a DNS-style slug, unique within the owning Workspace.
 * The slug doubles as the `@workspace/<project>` URL segment.
 */
const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface CreateProjectRequest {
  readonly workspaceId: string;
  readonly name: string;
  readonly slug: string;
  readonly projectJson?: Readonly<Record<string, unknown>>;
}

/** Persistence port for Projects backed by the control-plane store. */
export interface ProjectStore {
  createProjectRecord(input: ProjectCreationInput): Promise<ProjectCreationResult>;
  getWorkspaceManagement(
    workspaceId: string,
  ): Promise<WorkspaceManagement | undefined>;
  getProject(id: string): Promise<Project | undefined>;
  getProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<Project | undefined>;
  listProjectsByWorkspace(workspaceId: string): Promise<readonly Project[]>;
}

export interface ProjectsServiceDependencies {
  readonly store: ProjectStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

export class ProjectsService {
  readonly #store: ProjectStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;

  constructor(deps: ProjectsServiceDependencies) {
    this.#store = deps.store;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
  }

  async createProject(request: CreateProjectRequest): Promise<Project> {
    requireNonEmptyString(request.workspaceId, "workspaceId");
    requireNonEmptyString(request.name, "name");
    requireNonEmptyString(request.slug, "slug");
    if (!PROJECT_SLUG_PATTERN.test(request.slug)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `slug ${request.slug} must match ${PROJECT_SLUG_PATTERN.source}`,
      );
    }
    // Capture this exact private authority before the asynchronous slug
    // lookup and record preparation. The store repeats the epoch check in the
    // same atomic create boundary; never refresh it after those awaits.
    const expectedWorkspaceManagementAuthority =
      await this.#captureWorkspaceManagementAuthority(request.workspaceId);
    if (!expectedWorkspaceManagementAuthority) throw workspaceManagementAdmissionErrorFor();
    const existing = await this.#store.getProjectBySlug(
      request.workspaceId,
      request.slug,
    );
    if (existing) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "project already exists",
      );
    }
    const nowIso = this.#now().toISOString();
    const project: Project = {
      id: this.#newId("prj"),
      workspaceId: request.workspaceId,
      name: request.name,
      slug: request.slug,
      projectJson: request.projectJson ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    let result: ProjectCreationResult;
    try {
      result = await this.#store.createProjectRecord({
        project,
        expectedWorkspaceManagementAuthority,
      });
    } catch (error) {
      if (error instanceof WorkspaceManagementAdmissionConflictError) {
        throw workspaceManagementAdmissionErrorFor();
      }
      throw error;
    }
    if (result.status === "conflict") {
      // Preserve the existing duplicate-slug contract for a concurrent writer
      // that wins the store CAS between our read and publication.
      throw new OpenTofuControllerError(
        "failed_precondition",
        "project already exists",
      );
    }
    return result.project;
  }

  async getProject(id: string): Promise<Project> {
    requireNonEmptyString(id, "id");
    const project = await this.#store.getProject(id);
    if (!project) {
      throw new OpenTofuControllerError("not_found", `project ${id} not found`);
    }
    return project;
  }

  async listProjects(workspaceId: string): Promise<readonly Project[]> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const projects = await this.#store.listProjectsByWorkspace(workspaceId);
    if (projects.length > 0) return projects;
    try {
      return [await this.ensureDefaultProject(workspaceId)];
    } catch (error) {
      // An empty stopped Workspace is a valid read-only observation. Only the
      // exact management-admission refusal is converted to an empty list;
      // duplicate/conflict and all other failures remain visible to callers.
      if (isWorkspaceManagementAdmissionConflict(error)) return [];
      throw error;
    }
  }

  /**
   * Idempotently ensures the Workspace-qualified default Project exists for a
   * Workspace so pre-Project Capsules keep a stable owner. Returns the existing
   * default when already present.
   */
  async ensureDefaultProject(
    workspaceId: string,
    expectedWorkspaceManagementAuthority?: WorkspaceManagementAuthority,
  ): Promise<Project> {
    requireNonEmptyString(workspaceId, "workspaceId");
    if (expectedWorkspaceManagementAuthority !== undefined) {
      assertWorkspaceManagementAuthorityInput(expectedWorkspaceManagementAuthority, workspaceId);
    }
    const authority = expectedWorkspaceManagementAuthority ??
      (await this.#captureWorkspaceManagementAuthority(workspaceId));
    const existing = await this.#readDefaultProject(workspaceId);
    if (existing) return existing;
    // Existing defaults are read-only even while draining. A new default is
    // admitted only through createProjectRecord with this one captured epoch.
    if (!authority) throw workspaceManagementAdmissionErrorFor();
    const projectId = defaultProjectId(workspaceId);
    const nowIso = this.#now().toISOString();
    const project: Project = {
      id: projectId,
      workspaceId,
      name: "Default",
      slug: DEFAULT_PROJECT_SLUG,
      projectJson: {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    let result: ProjectCreationResult;
    try {
      result = await this.#store.createProjectRecord({
        project,
        expectedWorkspaceManagementAuthority: authority,
      });
    } catch (error) {
      if (error instanceof WorkspaceManagementAdmissionConflictError) {
        throw workspaceManagementAdmissionErrorFor();
      }
      throw error;
    }
    if (result.status === "created" || result.status === "replayed") {
      return result.project;
    }
    // A concurrent creator may have used a different timestamp (or a
    // different generated id) for the same default slug. Adopt the canonical
    // row after the CAS conflict; never overwrite it with our candidate.
    const canonical = await this.#readDefaultProject(workspaceId);
    if (canonical) return canonical;
    throw new OpenTofuControllerError(
      "failed_precondition",
      "project already exists",
    );
  }

  async #readDefaultProject(workspaceId: string): Promise<Project | undefined> {
    const byId = await this.#store.getProject(defaultProjectId(workspaceId));
    if (byId?.workspaceId === workspaceId) return byId;
    const bySlug = await this.#store.getProjectBySlug(
      workspaceId,
      DEFAULT_PROJECT_SLUG,
    );
    return bySlug?.workspaceId === workspaceId ? bySlug : undefined;
  }

  async #captureWorkspaceManagementAuthority(
    workspaceId: string,
  ): Promise<WorkspaceManagementAuthority | undefined> {
    const management = await this.#store.getWorkspaceManagement(workspaceId);
    if (
      !management ||
      management.workspaceId !== workspaceId ||
      management.managementState !== "active"
    ) {
      return undefined;
    }
    return {
      workspaceId: management.workspaceId,
      managementState: "active",
      managementEpoch: management.managementEpoch,
    };
  }
}

const WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_REASON =
  "workspace_management_admission_conflict";
const WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_MESSAGE =
  "Workspace is not accepting this management operation.";

function workspaceManagementAdmissionErrorFor(): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "failed_precondition",
    WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_MESSAGE,
    { reason: WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_REASON },
  );
}

function isWorkspaceManagementAdmissionConflict(error: unknown): boolean {
  if (!(error instanceof OpenTofuControllerError)) return false;
  const details = error.details;
  return (
    error.code === "failed_precondition" &&
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as { readonly reason?: unknown }).reason ===
      WORKSPACE_MANAGEMENT_ADMISSION_CONFLICT_REASON
  );
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
