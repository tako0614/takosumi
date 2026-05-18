/**
 * In-memory persistence for Installation + Deployment records.
 *
 * Wave 5 implementation — keeps things in process memory. A SQL-backed
 * variant is a follow-up wave concern.
 */
import type { Deployment, Installation } from "takosumi-contract/installer-api";

export interface InstallationStore {
  put(installation: Installation): Promise<Installation>;
  get(id: string): Promise<Installation | undefined>;
  list(spaceId?: string): Promise<readonly Installation[]>;
  patch(
    id: string,
    patch: Partial<Pick<Installation, "currentDeploymentId" | "status">>,
  ): Promise<Installation | undefined>;
}

export interface DeploymentStore {
  put(deployment: Deployment): Promise<Deployment>;
  get(id: string): Promise<Deployment | undefined>;
  listForInstallation(installationId: string): Promise<readonly Deployment[]>;
}

export class InMemoryInstallationStore implements InstallationStore {
  readonly #rows = new Map<string, Installation>();

  put(installation: Installation): Promise<Installation> {
    this.#rows.set(installation.id, installation);
    return Promise.resolve(installation);
  }

  get(id: string): Promise<Installation | undefined> {
    return Promise.resolve(this.#rows.get(id));
  }

  list(spaceId?: string): Promise<readonly Installation[]> {
    const rows = Array.from(this.#rows.values());
    if (spaceId === undefined) return Promise.resolve(rows);
    return Promise.resolve(rows.filter((row) => row.spaceId === spaceId));
  }

  patch(
    id: string,
    patch: Partial<Pick<Installation, "currentDeploymentId" | "status">>,
  ): Promise<Installation | undefined> {
    const existing = this.#rows.get(id);
    if (!existing) return Promise.resolve(undefined);
    const updated: Installation = { ...existing, ...patch };
    this.#rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

export class InMemoryDeploymentStore implements DeploymentStore {
  readonly #rows = new Map<string, Deployment>();

  put(deployment: Deployment): Promise<Deployment> {
    this.#rows.set(deployment.id, deployment);
    return Promise.resolve(deployment);
  }

  get(id: string): Promise<Deployment | undefined> {
    return Promise.resolve(this.#rows.get(id));
  }

  listForInstallation(
    installationId: string,
  ): Promise<readonly Deployment[]> {
    return Promise.resolve(
      Array.from(this.#rows.values()).filter((row) =>
        row.installationId === installationId
      ),
    );
  }
}
