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
 * table. The small in-memory implementation remains an explicit test helper.
 */

import type { Project } from "takosumi-contract/projects";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";

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

/**
 * Persistence port for Projects. The durable control plane provides a backing
 * implementation; {@link InMemoryProjectStore} is an explicit test helper.
 */
export interface ProjectStore {
  putProject(project: Project): Promise<Project>;
  getProject(id: string): Promise<Project | undefined>;
  getProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<Project | undefined>;
  listProjectsByWorkspace(workspaceId: string): Promise<readonly Project[]>;
}

/** Single-isolate {@link ProjectStore} for dev / tests. */
export class InMemoryProjectStore implements ProjectStore {
  readonly #byId = new Map<string, Project>();

  async putProject(project: Project): Promise<Project> {
    this.#byId.set(project.id, project);
    return project;
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.#byId.get(id);
  }

  async getProjectBySlug(
    workspaceId: string,
    slug: string,
  ): Promise<Project | undefined> {
    for (const project of this.#byId.values()) {
      if (project.workspaceId === workspaceId && project.slug === slug) {
        return project;
      }
    }
    return undefined;
  }

  async listProjectsByWorkspace(
    workspaceId: string,
  ): Promise<readonly Project[]> {
    return [...this.#byId.values()]
      .filter((project) => project.workspaceId === workspaceId)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }
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
    return await this.#store.putProject(project);
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
    return [await this.ensureDefaultProject(workspaceId)];
  }

  /**
   * Idempotently ensures the Workspace-qualified default Project exists for a
   * Workspace so pre-Project Capsules keep a stable owner. Returns the existing
   * default when already present.
   */
  async ensureDefaultProject(workspaceId: string): Promise<Project> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const projectId = defaultProjectId(workspaceId);
    const existing = await this.#store.getProject(projectId);
    if (existing) return existing;
    const bySlug = await this.#store.getProjectBySlug(
      workspaceId,
      DEFAULT_PROJECT_SLUG,
    );
    if (bySlug) return bySlug;
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
    return await this.#store.putProject(project);
  }
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
