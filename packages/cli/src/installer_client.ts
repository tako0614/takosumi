import type { Source, SourcePin } from "takosumi-contract/installer-api";
import {
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_ROLLBACK_PATH,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
} from "takosumi-contract/installer-api";
import { loadConfig, resolveMode } from "./config.ts";
import { callKernel } from "./remote_client.ts";

export interface RemoteInstallerTarget {
  readonly url: string;
  readonly token?: string;
}

export interface ExpectedPinOptions {
  readonly expectedCommit?: string;
  readonly expectedManifestDigest?: string;
  readonly expectedSourceDigest?: string;
}

export function parseSourceRef(ref: string): Source {
  if (ref.startsWith("git:")) {
    const rest = ref.slice("git:".length);
    const hash = rest.lastIndexOf("#");
    if (hash >= 0) {
      return {
        kind: "git",
        url: rest.slice(0, hash),
        ref: rest.slice(hash + 1),
      };
    }
    return { kind: "git", url: rest };
  }
  if (ref.startsWith("catalog:") || ref.startsWith("bundle:")) {
    throw new Error(
      "catalog: and bundle: installer sources are not part of the current public installer API; use git:, prepared:, or a local path",
    );
  }
  if (ref.startsWith("prepared:")) {
    const rest = ref.slice("prepared:".length);
    const hash = rest.lastIndexOf("#");
    if (hash >= 0) {
      return {
        kind: "prepared",
        url: rest.slice(0, hash),
        digest: rest.slice(hash + 1),
      };
    }
    return { kind: "prepared", url: rest };
  }
  return { kind: "local", url: ref };
}

export function expectedPinFromOptions(
  options: ExpectedPinOptions,
): SourcePin | undefined {
  const hasCommit = options.expectedCommit !== undefined;
  const hasDigest = options.expectedManifestDigest !== undefined;
  const hasSourceDigest = options.expectedSourceDigest !== undefined;
  if (!hasCommit && !hasDigest && !hasSourceDigest) return undefined;
  if (!hasDigest) {
    throw new Error(
      "--expected-manifest-digest is required when passing expected pins",
    );
  }
  return {
    ...(options.expectedCommit ? { commit: options.expectedCommit } : {}),
    manifestDigest: options.expectedManifestDigest!,
    ...(options.expectedSourceDigest
      ? { sourceDigest: options.expectedSourceDigest }
      : {}),
  };
}

export function resolveSourceArg(input: {
  readonly argument?: string;
  readonly flag?: string;
}): string {
  if (input.argument && input.flag && input.argument !== input.flag) {
    throw new Error(
      "pass the source either as an argument or with --source, not both",
    );
  }
  const source = input.flag ?? input.argument;
  if (!source) {
    throw new Error("source is required; pass <source> or --source <source>");
  }
  return source;
}

export async function requireRemoteInstaller(
  remote?: string,
  token?: string,
): Promise<RemoteInstallerTarget> {
  const target = resolveMode(
    { remote, token },
    await loadConfig({ tokenEnv: "installer" }),
  );
  if (target.mode !== "remote") {
    throw new Error(
      "installer commands require a remote kernel: pass --remote or set TAKOSUMI_REMOTE_URL",
    );
  }
  return { url: target.url, token: target.token };
}

export async function callInstaller(
  target: RemoteInstallerTarget,
  input: {
    readonly path: string;
    readonly body: unknown;
  },
): Promise<{ readonly status: number; readonly body: unknown }> {
  return await callKernel({
    url: target.url,
    token: target.token,
    path: input.path,
    body: input.body,
  });
}

export {
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_ROLLBACK_PATH,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
};
