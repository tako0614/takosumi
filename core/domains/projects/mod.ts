/**
 * Projects domain service (Workspace / Project / Capsule final model).
 *
 * A Project is a Workspace-owned grouping for one product, service,
 * application, or infrastructure group. Capsules live under a Project
 * (`capsules.projectId`); a default Project (`prj_default`) is backfilled per
 * Workspace so existing Workspace-direct Capsules keep a stable owner.
 *
 * This service owns Project creation + lookup and the slug-uniqueness invariant
 * within a Workspace. No secret material flows through it.
 *
 * NOTE (rename convergence): the shared OpenTofu deployment store does not yet
 * expose Project persistence methods. To keep this service self-contained and
 * testable today, it depends on a small {@link ProjectStore} port with an
 * in-memory default. Wiring it onto the durable control-plane ledger (D1 /
 * Postgres `projects` table + `create_projects_table` migration + bootstrap
 * construction) is a converge follow-up once the spine store gains Project
 * accessors.
 */

import type { Project } from "takosumi-contract/projects";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";

/** The default per-Workspace Project id Capsules are backfilled under. */
export const DEFAULT_PROJECT_ID = "prj_default";

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
 * implementation; {@link InMemoryProjectStore} is the dev/test default.
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
    return await this.#store.listProjectsByWorkspace(workspaceId);
  }

  /**
   * Idempotently ensures the default Project (`prj_default`) exists for a
   * Workspace so pre-Project Capsules keep a stable owner. Returns the existing
   * default when already present.
   */
  async ensureDefaultProject(workspaceId: string): Promise<Project> {
    requireNonEmptyString(workspaceId, "workspaceId");
    const existing = await this.#store.getProject(DEFAULT_PROJECT_ID);
    if (existing && existing.workspaceId === workspaceId) return existing;
    const bySlug = await this.#store.getProjectBySlug(
      workspaceId,
      DEFAULT_PROJECT_SLUG,
    );
    if (bySlug) return bySlug;
    const nowIso = this.#now().toISOString();
    const project: Project = {
      id: DEFAULT_PROJECT_ID,
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
