import type { Interface, InterfaceBinding, InterfaceLink } from "takosumi-contract/interfaces";
import type { Page, PageParams } from "takosumi-contract/pagination";
import {
  pageSortedBy,
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
} from "takosumi-contract";
import { freezeClone } from "../../shared/freeze.ts";
import type { InterfaceMaterializationWriteAuthority } from "../deploy-control/interface_materialization_intent.ts";
import {
  WorkspaceManagementAdmissionConflictError,
  assertWorkspaceManagementAuthorityInput,
  type WorkspaceManagementAdmissionValidator,
  type WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";
import { interfaceOAuth2ResourceUri } from "./oauth_resource.ts";

export interface InterfaceMaterializationAuthorityValidator {
  isCapsuleInterfaceMaterializationWriteAuthorityCurrent(
    authority: InterfaceMaterializationWriteAuthority,
    checkedAt: string,
  ): boolean;
}

export interface InterfaceListFilter {
  readonly workspaceId: string;
  readonly type?: string;
  readonly phase?: Interface["status"]["phase"];
  readonly ownerKind?: Interface["metadata"]["ownerRef"]["kind"];
  readonly ownerId?: string;
  /** Bounded internal batch selector; never accepted directly from public API. */
  readonly ownerIds?: readonly string[];
  /** Bounded internal read limit. */
  readonly limit?: number;
  readonly includeRetired?: boolean;
}

export interface InterfaceWriteGuard {
  readonly generation: number;
  readonly resolvedRevision: number;
  /** Exact prior row prevents lost condition-only lifecycle updates. */
  readonly record: Interface;
  /** Internal fence for a newly queued observer marker. */
  readonly requireActiveWorkspace?: true;
}

export interface InterfaceStore {
  create(
    record: Interface,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean>;
  get(id: string): Promise<Interface | undefined>;
  getByName(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly name: string;
  }): Promise<Interface | undefined>;
  list(filter: InterfaceListFilter): Promise<readonly Interface[]>;
  /** Internal global keyset scan used only for bounded host projection repair. */
  listProjectionPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<readonly Interface[]>;
  compareAndSet(
    record: Interface,
    expected: InterfaceWriteGuard,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean>;
  /**
   * Atomically reserves one canonical OAuth resource for this exact current
   * Interface generation/revision. Durable implementations enforce uniqueness
   * for `(Workspace, ownerRef, resource)` in the database.
   */
  claimOAuth2Resource(input: {
    readonly record: Interface;
    readonly resource: string;
  }, authority?: InterfaceMaterializationWriteAuthority): Promise<boolean>;
  findOAuth2ResourceClaim(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly resource: string;
  }): Promise<string | undefined>;
}

export interface InterfaceBindingStore {
  create(
    record: InterfaceBinding,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean>;
  get(id: string): Promise<InterfaceBinding | undefined>;
  listByInterface(interfaceId: string): Promise<readonly InterfaceBinding[]>;
  compareAndSet(
    record: InterfaceBinding,
    expectedGeneration: number,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean>;
}

export interface InterfaceStores {
  /** Composition-time persistence assertion used by strict runtime gates. */
  readonly persistence: "durable" | "ephemeral";
  readonly interfaces: InterfaceStore;
  readonly bindings: InterfaceBindingStore;
  readonly links: InterfaceLinkStore;
  /**
   * Read-only authorization projection. Durable implementations collapse the
   * Interface + current Principal Binding check into one bounded statement.
   */
  readonly authorized: InterfaceAuthorizationQuery;
}

export interface InterfaceLinkKey {
  readonly consumerCapsuleId: string;
  readonly requirementKey: string;
}

export interface InterfaceLinkReplacement {
  readonly record: InterfaceLink;
  readonly expected: InterfaceLink;
  /** Required for a current link, omitted when replacing a terminal link. */
  readonly revoked?: InterfaceLink;
}

export interface InterfaceLinkStore {
  /** Whether link persistence is installed on this backing store. */
  available?(): Promise<boolean>;
  /** First selection only; subsequent selections use the atomic replacement. */
  create(record: InterfaceLink, guard?: WorkspaceManagementAuthority): Promise<boolean>;
  get(id: string): Promise<InterfaceLink | undefined>;
  getCurrent(key: InterfaceLinkKey): Promise<InterfaceLink | undefined>;
  getLatest(key: InterfaceLinkKey): Promise<InterfaceLink | undefined>;
  listByConsumerCapsule(id: string): Promise<readonly InterfaceLink[]>;
  listByProviderInterface(id: string): Promise<readonly InterfaceLink[]>;
  listByProviderCapsule(id: string): Promise<readonly InterfaceLink[]>;
  compareAndSet(record: InterfaceLink, expectedGeneration: number, guard?: WorkspaceManagementAuthority): Promise<boolean>;
  /** Atomic exact-prior CAS, old revocation, and new selection insertion. */
  replace(input: InterfaceLinkReplacement, guard?: WorkspaceManagementAuthority): Promise<boolean>;
}

export function isCurrentInterfaceLink(record: InterfaceLink): boolean {
  return record.state === "pending_approval" || record.state === "active";
}

export function isValidInterfaceLinkUpdate(record: InterfaceLink, prior: InterfaceLink): boolean {
  return isCurrentInterfaceLink(prior) && record.id === prior.id &&
    Number.isSafeInteger(record.generation) && record.generation === prior.generation + 1 &&
    record.consumerCapsuleId === prior.consumerCapsuleId && record.requirementKey === prior.requirementKey &&
    record.providerInterfaceId === prior.providerInterfaceId && record.providerCapsuleId === prior.providerCapsuleId &&
    record.interface.type === prior.interface.type && record.interface.version === prior.interface.version &&
    JSON.stringify(record.requestedPermissions) === JSON.stringify(prior.requestedPermissions) &&
    record.deliveryType === prior.deliveryType && record.selection === prior.selection &&
    record.requestedBy === prior.requestedBy && record.createdAt === prior.createdAt;
}

export function isValidInterfaceLinkReplacement(input: InterfaceLinkReplacement): boolean {
  const { record, expected, revoked } = input;
  const current = isCurrentInterfaceLink(expected);
  return record.id !== expected.id && isCurrentInterfaceLink(record) &&
    record.consumerCapsuleId === expected.consumerCapsuleId && record.requirementKey === expected.requirementKey &&
    Number.isSafeInteger(record.generation) && record.generation === expected.generation + (current ? 2 : 1) &&
    (current ? !!revoked && revoked.state === "revoked" && isValidInterfaceLinkUpdate(revoked, expected) : revoked === undefined);
}

export class InMemoryInterfaceLinkStore implements InterfaceLinkStore {
  readonly #records = new Map<string, InterfaceLink>();

  constructor(private readonly workspaceManagementAuthority?: WorkspaceManagementAdmissionValidator) {}

  #writeAllowed(guard?: WorkspaceManagementAuthority): boolean {
    if (!guard) return true;
    assertWorkspaceManagementAuthorityInput(guard, guard.workspaceId);
    return this.workspaceManagementAuthority?.isWorkspaceManagementAdmissionAllowed(guard.workspaceId, guard) === true;
  }

  create(record: InterfaceLink, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    if (!this.#writeAllowed(guard)) return Promise.resolve(false);
    if (record.generation !== 1 || !isCurrentInterfaceLink(record) || this.#records.has(record.id) ||
      this.#latest(record)) return Promise.resolve(false);
    this.#records.set(record.id, freezeClone(record));
    return Promise.resolve(true);
  }

  get(id: string): Promise<InterfaceLink | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  getCurrent(key: InterfaceLinkKey): Promise<InterfaceLink | undefined> {
    const record = this.#latest(key);
    return Promise.resolve(record && isCurrentInterfaceLink(record) ? record : undefined);
  }

  getLatest(key: InterfaceLinkKey): Promise<InterfaceLink | undefined> {
    return Promise.resolve(this.#latest(key));
  }

  listByConsumerCapsule(id: string): Promise<readonly InterfaceLink[]> {
    return Promise.resolve(this.#list("consumerCapsuleId", id));
  }

  listByProviderInterface(id: string): Promise<readonly InterfaceLink[]> {
    return Promise.resolve(this.#list("providerInterfaceId", id));
  }

  listByProviderCapsule(id: string): Promise<readonly InterfaceLink[]> {
    return Promise.resolve(this.#list("providerCapsuleId", id));
  }

  compareAndSet(record: InterfaceLink, expectedGeneration: number, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    if (!this.#writeAllowed(guard)) return Promise.resolve(false);
    const prior = this.#records.get(record.id);
    if (!prior || prior.generation !== expectedGeneration || !isValidInterfaceLinkUpdate(record, prior)) {
      return Promise.resolve(false);
    }
    this.#records.set(record.id, freezeClone(record));
    return Promise.resolve(true);
  }

  replace(input: InterfaceLinkReplacement, guard?: WorkspaceManagementAuthority): Promise<boolean> {
    if (!this.#writeAllowed(guard)) return Promise.resolve(false);
    if (!isValidInterfaceLinkReplacement(input)) return Promise.resolve(false);
    const { record, expected, revoked } = input;
    const prior = this.#records.get(expected.id);
    if (!prior || JSON.stringify(prior) !== JSON.stringify(expected) ||
      this.#latest(expected)?.id !== expected.id || this.#records.has(record.id)) return Promise.resolve(false);
    if (revoked) this.#records.set(revoked.id, freezeClone(revoked));
    this.#records.set(record.id, freezeClone(record));
    return Promise.resolve(true);
  }

  #latest(key: InterfaceLinkKey): InterfaceLink | undefined {
    return this.#list("consumerCapsuleId", key.consumerCapsuleId)
      .filter((record) => record.requirementKey === key.requirementKey)
      .sort((left, right) => right.generation - left.generation)[0];
  }

  #list(key: "consumerCapsuleId" | "providerInterfaceId" | "providerCapsuleId", id: string): InterfaceLink[] {
    return [...this.#records.values()].filter((record) => record[key] === id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
}

/**
 * Filter for the Principal Binding projection. Without `workspaceId` the
 * projection spans every internal partition (TASK-0118 9.1): the exact
 * current Principal Binding is the only authority either way.
 */
export type InterfaceAuthorizationFilter =
  & Omit<InterfaceListFilter, "workspaceId">
  & { readonly workspaceId?: string };

/**
 * The consumer app of a Workspace-free runtime principal (TASK-0118 9.1).
 * Its pairwise subject is learnable by providers it talks to, and anyone who
 * may write Bindings in some partition (including another tenant of a shared
 * legacy partition) can bind that subject, so a Binding counts as its
 * evidence only when it was materialized from an active Interface link of
 * this app, or sits on an Interface this app itself owns.
 */
export interface InterfaceRuntimeConsumer {
  readonly capsuleId: string;
}

export function bindingServesRuntimeConsumer(
  binding: InterfaceBinding,
  iface: Interface,
  consumer: InterfaceRuntimeConsumer,
): boolean {
  if (iface.metadata.ownerRef.kind === "Capsule" &&
    iface.metadata.ownerRef.id === consumer.capsuleId) return true;
  const source = binding.metadata.materializedFrom;
  return source?.source === "capsule_required_interface" &&
    source.capsuleId === consumer.capsuleId;
}

export interface InterfaceAuthorizationPageInput {
  readonly filter: InterfaceAuthorizationFilter;
  /** Required evidence shape for a Workspace-free runtime principal. */
  readonly consumer?: InterfaceRuntimeConsumer;
  readonly subjectId: string;
  readonly permission: string;
  readonly params: PageParams;
  /**
   * Narrows the scan to launcher candidates without treating the opaque
   * document as authorization. The exact Principal Binding remains authority;
   * the dashboard still validates the complete type-specific document.
   */
  readonly uiSurfaceCandidates?: boolean;
  /** Applies only to Capsule-owned candidates. */
  readonly capsuleId?: string;
}

export interface InterfaceAuthorizationQuery {
  listPage(
    input: InterfaceAuthorizationPageInput,
  ): Promise<Page<Interface>>;
}

export class InMemoryInterfaceStore implements InterfaceStore {
  readonly #records = new Map<string, Interface>();
  readonly #oauthResourceClaims = new Map<string, string>();
  readonly #oauthResourceClaimKeys = new Map<string, string>();

  constructor(
    private readonly materializationAuthority?: InterfaceMaterializationAuthorityValidator,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly workspaceManagementAuthority?: WorkspaceManagementAdmissionValidator,
  ) {}

  create(
    record: Interface,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (!this.#writeAuthorized(record, authority)) return Promise.resolve(false);
    if (this.#records.has(record.metadata.id)) return Promise.resolve(false);
    for (const existing of this.#records.values()) {
      if (sameName(existing, record) && existing.status.phase !== "Retired") {
        return Promise.resolve(false);
      }
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    return Promise.resolve(true);
  }

  get(id: string): Promise<Interface | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  /** Internal synchronous lookup used to keep in-memory Binding fencing atomic. */
  getCurrent(id: string): Interface | undefined {
    return this.#records.get(id);
  }

  getByName(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly name: string;
  }): Promise<Interface | undefined> {
    for (const record of this.#records.values()) {
      if (
        record.metadata.workspaceId === input.workspaceId &&
        record.metadata.ownerRef.kind === input.ownerKind &&
        record.metadata.ownerRef.id === input.ownerId &&
        record.metadata.name === input.name &&
        record.status.phase !== "Retired"
      )
        return Promise.resolve(record);
    }
    return Promise.resolve(undefined);
  }

  list(filter: InterfaceListFilter): Promise<readonly Interface[]> {
    const records = [...this.#records.values()]
      .filter((record) => matches(record, filter))
      .sort(
        (left, right) =>
          left.metadata.name.localeCompare(right.metadata.name) ||
          left.metadata.id.localeCompare(right.metadata.id),
      );
    return Promise.resolve(
      filter.limit === undefined ? records : records.slice(0, filter.limit),
    );
  }

  listProjectionPage(input: {
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<readonly Interface[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter(
          (record) =>
            !input.cursor || record.metadata.id.localeCompare(input.cursor) > 0,
        )
        .sort((left, right) =>
          left.metadata.id.localeCompare(right.metadata.id),
        )
        .slice(0, input.limit)
        .map(freezeClone),
    );
  }

  compareAndSet(
    record: Interface,
    expected: InterfaceWriteGuard,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (!this.#writeAuthorized(record, authority)) return Promise.resolve(false);
    const current = this.#records.get(record.metadata.id);
    if (!current) return Promise.resolve(false);
    if (expected.requireActiveWorkspace === true) {
      if (
        record.metadata.workspaceId !== expected.record.metadata.workspaceId
      ) {
        return Promise.resolve(false);
      }
      if (
        !this.workspaceManagementAuthority?.isWorkspaceManagementAdmissionAllowed(
          current.metadata.workspaceId,
        )
      ) {
        return Promise.reject(
          new WorkspaceManagementAdmissionConflictError(
            current.metadata.workspaceId,
          ),
        );
      }
    }
    if (
      current.metadata.generation !== expected.generation ||
      current.status.resolvedRevision !== expected.resolvedRevision ||
      JSON.stringify(current) !== JSON.stringify(expected.record)
    )
      return Promise.resolve(false);
    for (const existing of this.#records.values()) {
      if (
        existing.metadata.id !== record.metadata.id &&
        sameName(existing, record) &&
        existing.status.phase !== "Retired"
      )
        return Promise.resolve(false);
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    const claimedKey = this.#oauthResourceClaimKeys.get(record.metadata.id);
    if (claimedKey) {
      const nextResource = interfaceOAuth2ResourceUri(record);
      const nextKey = nextResource
        ? oauthResourceClaimKey({
            workspaceId: record.metadata.workspaceId,
            ownerKind: record.metadata.ownerRef.kind,
            ownerId: record.metadata.ownerRef.id,
            resource: nextResource,
          })
        : undefined;
      if (claimedKey !== nextKey) {
        this.#oauthResourceClaims.delete(claimedKey);
        this.#oauthResourceClaimKeys.delete(record.metadata.id);
      }
    }
    return Promise.resolve(true);
  }

  claimOAuth2Resource(input: {
    readonly record: Interface;
    readonly resource: string;
  }, authority?: InterfaceMaterializationWriteAuthority): Promise<boolean> {
    if (!this.#writeAuthorized(input.record, authority)) {
      return Promise.resolve(false);
    }
    const current = this.#records.get(input.record.metadata.id);
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(input.record) ||
      interfaceOAuth2ResourceUri(current) !== input.resource
    ) {
      return Promise.resolve(false);
    }
    const key = oauthResourceClaimKey({
      workspaceId: current.metadata.workspaceId,
      ownerKind: current.metadata.ownerRef.kind,
      ownerId: current.metadata.ownerRef.id,
      resource: input.resource,
    });
    const owner = this.#oauthResourceClaims.get(key);
    if (owner && owner !== current.metadata.id) return Promise.resolve(false);
    const prior = this.#oauthResourceClaimKeys.get(current.metadata.id);
    if (prior && prior !== key) this.#oauthResourceClaims.delete(prior);
    this.#oauthResourceClaims.set(key, current.metadata.id);
    this.#oauthResourceClaimKeys.set(current.metadata.id, key);
    return Promise.resolve(true);
  }

  #writeAuthorized(
    record: Interface,
    authority: InterfaceMaterializationWriteAuthority | undefined,
  ): boolean {
    if (!authority) return true;
    return (
      record.metadata.workspaceId === authority.workspaceId &&
      record.metadata.ownerRef.kind === "Capsule" &&
      record.metadata.ownerRef.id === authority.capsuleId &&
      this.materializationAuthority?.isCapsuleInterfaceMaterializationWriteAuthorityCurrent(
        authority,
        this.now(),
      ) === true
    );
  }

  findOAuth2ResourceClaim(input: {
    readonly workspaceId: string;
    readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
    readonly ownerId: string;
    readonly resource: string;
  }): Promise<string | undefined> {
    return Promise.resolve(
      this.#oauthResourceClaims.get(oauthResourceClaimKey(input)),
    );
  }
}

export class InMemoryInterfaceBindingStore implements InterfaceBindingStore {
  readonly #records = new Map<string, InterfaceBinding>();

  constructor(
    private readonly interfaces: InMemoryInterfaceStore,
    private readonly materializationAuthority?: InterfaceMaterializationAuthorityValidator,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  create(
    record: InterfaceBinding,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (!this.#writeAuthorized(record, authority)) return Promise.resolve(false);
    if (this.#records.has(record.metadata.id)) return Promise.resolve(false);
    for (const existing of this.#records.values()) {
      if (
        existing.spec.interfaceId === record.spec.interfaceId &&
        existing.spec.subjectRef.kind === record.spec.subjectRef.kind &&
        existing.spec.subjectRef.id === record.spec.subjectRef.id &&
        existing.status.phase !== "Revoked"
      )
        return Promise.resolve(false);
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    return Promise.resolve(true);
  }

  get(id: string): Promise<InterfaceBinding | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  /** Synchronous custody census over this actual store, including revoked,
   * orphan and other-Workspace references; ordinary authorization is unchanged. */
  retainedPrincipalReferences(accountIds: readonly string[]): readonly { readonly id: string; readonly workspaceId: string; readonly subjectId: string; readonly record: unknown }[] {
    const roots = new Set(accountIds);
    return [...this.#records.values()].filter((record) => record.spec.subjectRef.kind === "Principal" && roots.has(record.spec.subjectRef.id))
      .map((record) => ({ id: record.metadata.id, workspaceId: record.metadata.workspaceId, subjectId: record.spec.subjectRef.id, record: freezeClone(record) }));
  }

  listByInterface(interfaceId: string): Promise<readonly InterfaceBinding[]> {
    return Promise.resolve(
      [...this.#records.values()]
        .filter((record) => record.spec.interfaceId === interfaceId)
        .sort(
          (left, right) =>
            left.metadata.createdAt.localeCompare(right.metadata.createdAt) ||
            left.metadata.id.localeCompare(right.metadata.id),
        ),
    );
  }

  compareAndSet(
    record: InterfaceBinding,
    expectedGeneration: number,
    authority?: InterfaceMaterializationWriteAuthority,
  ): Promise<boolean> {
    if (!this.#writeAuthorized(record, authority)) return Promise.resolve(false);
    const current = this.#records.get(record.metadata.id);
    if (!current || current.metadata.generation !== expectedGeneration) {
      return Promise.resolve(false);
    }
    this.#records.set(record.metadata.id, freezeClone(record));
    return Promise.resolve(true);
  }

  #writeAuthorized(
    record: InterfaceBinding,
    authority: InterfaceMaterializationWriteAuthority | undefined,
  ): boolean {
    if (!authority) return true;
    const currentInterface = this.interfaces.getCurrent(
      record.spec.interfaceId,
    );
    if (!currentInterface) return false;
    return (
      record.metadata.workspaceId === authority.workspaceId &&
      currentInterface.metadata.workspaceId === authority.workspaceId &&
      currentInterface.metadata.ownerRef.kind === "Capsule" &&
      currentInterface.metadata.ownerRef.id === authority.capsuleId &&
      this.materializationAuthority?.isCapsuleInterfaceMaterializationWriteAuthorityCurrent(
        authority,
        this.now(),
      ) === true
    );
  }
}

export function createInMemoryInterfaceStores(options: {
  readonly materializationAuthority?: InterfaceMaterializationAuthorityValidator;
  readonly now?: () => string;
  readonly workspaceManagementAuthority?: WorkspaceManagementAdmissionValidator;
} = {}): InterfaceStores {
  const now = options.now ?? (() => new Date().toISOString());
  const interfaces = new InMemoryInterfaceStore(
    options.materializationAuthority,
    now,
    options.workspaceManagementAuthority,
  );
  const bindings = new InMemoryInterfaceBindingStore(
    interfaces,
    options.materializationAuthority,
    now,
  );
  const links = new InMemoryInterfaceLinkStore(options.workspaceManagementAuthority);
  return {
    persistence: "ephemeral",
    interfaces,
    bindings,
    links,
    authorized: new InMemoryInterfaceAuthorizationQuery(
      interfaces,
      bindings,
      links,
    ),
  };
}

class InMemoryInterfaceAuthorizationQuery
  implements InterfaceAuthorizationQuery
{
  constructor(
    private readonly interfaces: InterfaceStore,
    private readonly bindings: InterfaceBindingStore,
    private readonly links: InterfaceLinkStore,
  ) {}

  async listPage(
    input: InterfaceAuthorizationPageInput,
  ): Promise<Page<Interface>> {
    const filter = {
      ...input.filter,
      phase: input.filter.phase ?? "Resolved",
      includeRetired: false,
      limit: undefined,
    };
    const workspaceId = filter.workspaceId;
    const listed = workspaceId !== undefined
      ? await this.interfaces.list({ ...filter, workspaceId })
      : await this.#listAcrossPartitions(filter);
    const candidates = listed.filter((iface) => {
      if (hasUnownedCapsuleOutput(iface)) return false;
      if (
        input.uiSurfaceCandidates &&
        !isUiSurfaceCandidate(iface, input.capsuleId)
      ) {
        return false;
      }
      return true;
    });
    const authorized: Interface[] = [];
    for (const iface of candidates) {
      const bindings = await this.bindings.listByInterface(iface.metadata.id);
      for (const binding of bindings) {
        if (
          isCurrentPrincipalGrant(
            binding,
            iface,
            input.subjectId,
            input.permission,
          ) && await hasActiveRequiredInterfaceLink(binding, iface, this.links, input.permission) &&
          (input.consumer === undefined || bindingServesRuntimeConsumer(binding, iface, input.consumer))
        ) {
          authorized.push(iface);
          break;
        }
      }
    }
    authorized.sort(
      (left, right) =>
        left.metadata.createdAt.localeCompare(right.metadata.createdAt) ||
        left.metadata.id.localeCompare(right.metadata.id),
    );
    return pageSortedBy(authorized, input.params, (iface) => ({
      createdAt: iface.metadata.createdAt,
      id: iface.metadata.id,
    }));
  }

  /** Every partition, through the store's own global keyset scan. */
  async #listAcrossPartitions(
    filter: InterfaceAuthorizationFilter,
  ): Promise<readonly Interface[]> {
    const rows: Interface[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.interfaces.listProjectionPage({
        ...(cursor !== undefined ? { cursor } : {}),
        limit: 500,
      });
      for (const iface of page) {
        if (matches(iface, { ...filter, workspaceId: iface.metadata.workspaceId })) rows.push(iface);
      }
      if (page.length < 500) return rows;
      cursor = page[page.length - 1]!.metadata.id;
    }
  }
}

async function hasActiveRequiredInterfaceLink(binding: InterfaceBinding, iface: Interface, links: InterfaceLinkStore, permission: string): Promise<boolean> {
  const source = binding.metadata.materializedFrom;
  if (source?.source !== "capsule_required_interface") return true;
  const link = source.linkId ? await links.get(source.linkId)
    : await links.getCurrent({ consumerCapsuleId: source.capsuleId, requirementKey: source.requirementKey });
  return !!link && link.state === "active" && link.providerInterfaceId === binding.spec.interfaceId &&
    iface.metadata.ownerRef.kind === "Capsule" && link.providerCapsuleId === iface.metadata.ownerRef.id &&
    link.consumerCapsuleId === source.capsuleId && link.requirementKey === source.requirementKey &&
    link.interface.type === source.interfaceType && link.interface.version === source.interfaceVersion &&
    link.interface.type === iface.spec.type && link.interface.version === iface.spec.version &&
    link.deliveryType === binding.spec.delivery.type &&
    link.requestedPermissions.includes(permission) && link.approvedPermissions.includes(permission);
}

function hasUnownedCapsuleOutput(iface: Interface): boolean {
  return Object.values(iface.spec.inputs ?? {}).some(
    (source) =>
      source.source === "capsule_output" &&
      (iface.metadata.ownerRef.kind !== "Capsule" ||
        source.capsuleId !== iface.metadata.ownerRef.id),
  );
}

function sameName(left: Interface, right: Interface): boolean {
  return (
    left.metadata.workspaceId === right.metadata.workspaceId &&
    left.metadata.ownerRef.kind === right.metadata.ownerRef.kind &&
    left.metadata.ownerRef.id === right.metadata.ownerRef.id &&
    left.metadata.name === right.metadata.name
  );
}

function oauthResourceClaimKey(input: {
  readonly workspaceId: string;
  readonly ownerKind: Interface["metadata"]["ownerRef"]["kind"];
  readonly ownerId: string;
  readonly resource: string;
}): string {
  return JSON.stringify([
    input.workspaceId,
    input.ownerKind,
    input.ownerId,
    input.resource,
  ]);
}

function matches(record: Interface, filter: InterfaceListFilter): boolean {
  return (
    record.metadata.workspaceId === filter.workspaceId &&
    (filter.type === undefined || record.spec.type === filter.type) &&
    (filter.phase === undefined || record.status.phase === filter.phase) &&
    (filter.ownerKind === undefined ||
      record.metadata.ownerRef.kind === filter.ownerKind) &&
    (filter.ownerId === undefined ||
      record.metadata.ownerRef.id === filter.ownerId) &&
    (filter.ownerIds === undefined ||
      filter.ownerIds.includes(record.metadata.ownerRef.id)) &&
    (filter.includeRetired === true || record.status.phase !== "Retired")
  );
}

function isUiSurfaceCandidate(
  iface: Interface,
  capsuleId: string | undefined,
): boolean {
  if (iface.metadata.ownerRef.kind === "Capsule") {
    return (
      (capsuleId === undefined || iface.metadata.ownerRef.id === capsuleId) &&
      iface.spec.type === UI_SURFACE_INTERFACE_TYPE &&
      iface.spec.version === UI_SURFACE_INTERFACE_VERSION
    );
  }
  return false;
}

function isCurrentPrincipalGrant(
  binding: InterfaceBinding,
  iface: Interface,
  subjectId: string,
  permission: string,
): boolean {
  return (
    iface.status.phase === "Resolved" &&
    binding.metadata.workspaceId === iface.metadata.workspaceId &&
    binding.spec.interfaceId === iface.metadata.id &&
    binding.spec.subjectRef.kind === "Principal" &&
    binding.spec.subjectRef.id === subjectId &&
    binding.spec.permissions.includes(permission) &&
    binding.status.phase === "Ready" &&
    binding.status.observedInterfaceRevision === iface.status.resolvedRevision
  );
}
