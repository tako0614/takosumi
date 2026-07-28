/** Provider-neutral Source credential driver lookup. */
import type { ProviderConnection } from "takosumi-contract/connections";
import type { SourceGitConnectionKind } from "takosumi-contract/sources";
import type {
  CredentialDriverFetch,
  SourceCredentialDriverRegistry,
  SourceCredentialRuntimeDriver,
} from "./driver_ports.ts";

export type VerifyFetch = CredentialDriverFetch;

export function sourceCredentialDriverForKind(
  kind: SourceGitConnectionKind | undefined,
  registry: SourceCredentialDriverRegistry,
): SourceCredentialRuntimeDriver | undefined {
  if (!kind) return undefined;
  return registry[kind];
}

export function sourceCredentialDriverForConnection(
  connection: ProviderConnection,
  registry: SourceCredentialDriverRegistry,
): SourceCredentialRuntimeDriver | undefined {
  return connection.kind === "source_git_https_token" ||
    connection.kind === "source_git_ssh_key"
    ? sourceCredentialDriverForKind(connection.kind, registry)
    : undefined;
}
