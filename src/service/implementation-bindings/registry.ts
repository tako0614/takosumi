/**
 * Service implementation registry — owns the set of operator-supplied
 * `OperatorImplementation` instances and resolves exact kind references to the implementation
 * that materializes them.
 */
import type { OperatorImplementation } from "takosumi-contract/reference/implementation";
import type { OperatorImplementationRegistry } from "./types.ts";

export class InMemoryOperatorImplementationRegistry implements OperatorImplementationRegistry {
  readonly #implementations: OperatorImplementation[] = [];
  readonly #byKindUri = new Map<string, OperatorImplementation>();
  readonly #byName = new Map<string, OperatorImplementation>();

  constructor(
    implementations: readonly OperatorImplementation[] = [],
  ) {
    for (const implementation of implementations) this.register(implementation);
  }

  register(implementation: OperatorImplementation): void {
    assertValidImplementation(implementation);
    if (this.#byName.has(implementation.name)) {
      throw new Error(`service implementation already registered: ${implementation.name}`);
    }
    for (const kindUri of implementation.provides) {
      const existing = this.#byKindUri.get(kindUri);
      if (existing) {
        throw new Error(
          `service implementation ${implementation.name} conflicts on kind ${kindUri}; ${existing.name} already provides it`,
        );
      }
    }
    this.#implementations.push(implementation);
    this.#byName.set(implementation.name, implementation);
    for (const kindUri of implementation.provides) {
      this.#byKindUri.set(kindUri, implementation);
    }
  }

  list(): readonly OperatorImplementation[] {
    return Object.freeze([...this.#implementations]);
  }

  findByKindUri(kindUri: string): OperatorImplementation | undefined {
    return this.#byKindUri.get(kindUri);
  }

  getByName(name: string): OperatorImplementation | undefined {
    return this.#byName.get(name);
  }
}

export function createOperatorImplementationRegistry(
  implementations: readonly OperatorImplementation[] = [],
): OperatorImplementationRegistry {
  return new InMemoryOperatorImplementationRegistry(implementations);
}

/**
 * Find the implementation that should materialize a given kind reference.
 *
 * Takosumi v1 does not expand short aliases: the operator-selected kind
 * reference is looked up verbatim. Full `http(s)` URIs and bare tokens are
 * resolved by exact match against each implementation's `provides[]`; an
 * unknown reference returns `undefined`.
 */
export function findImplementationForKind(
  registry: OperatorImplementationRegistry,
  kind: string,
): OperatorImplementation | undefined {
  return registry.findByKindUri(kind);
}

function assertValidImplementation(implementation: OperatorImplementation): void {
  if (!implementation.name?.trim()) {
    throw new Error("service implementation name is required");
  }
  if (!implementation.version?.trim()) {
    throw new Error(`service implementation version is required: ${implementation.name}`);
  }
  if (!Array.isArray(implementation.provides) || implementation.provides.length === 0) {
    throw new Error(
      `service implementation ${implementation.name} must advertise at least one kind URI in provides[]`,
    );
  }
  for (const kindUri of implementation.provides) {
    if (typeof kindUri !== "string" || kindUri.length === 0) {
      throw new Error(
        `service implementation ${implementation.name} has invalid provides[] entry`,
      );
    }
  }
  if (typeof implementation.apply !== "function") {
    throw new Error(`service implementation ${implementation.name} must define apply()`);
  }
}
