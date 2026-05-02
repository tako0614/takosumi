import type { storage } from "takosumi-contract";

export interface CloudflareD1StorageClient {
  readonly statements: storage.StorageStatementCatalog;
  transaction<T>(
    fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T>;
}

export class CloudflareD1StorageAdapter implements storage.StorageDriver {
  readonly #client: CloudflareD1StorageClient;

  constructor(client: CloudflareD1StorageClient) {
    this.#client = client;
  }

  get statements(): storage.StorageStatementCatalog {
    return this.#client.statements;
  }

  transaction<T>(
    fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    return this.#client.transaction(fn);
  }
}
