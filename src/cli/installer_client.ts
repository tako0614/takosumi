import type {
  DeploymentExpectedGuard,
  Source,
  SourcePin,
} from "takosumi-contract/installer-api";
import {
  INSTALLATION_DEPLOYMENTS_DRY_RUN_PATH,
  INSTALLATION_DEPLOYMENTS_PATH,
  INSTALLATION_ROLLBACK_PATH,
  INSTALLATIONS_DRY_RUN_PATH,
  INSTALLATIONS_PATH,
} from "takosumi-contract/installer-api";
import { loadConfig, resolveMode } from "./config.ts";
import { callTakosumiService } from "./remote_client.ts";

export interface RemoteInstallerTarget {
  readonly url: string;
  readonly token?: string;
}

export interface ExpectedPinOptions {
  readonly expectedCommit?: string;
  readonly expectedPlanSnapshotDigest?: string;
  readonly expectedSourceDigest?: string;
}

export interface DeploymentExpectedGuardOptions extends ExpectedPinOptions {
  readonly expectedCurrentDeploymentId?: string;
}

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function parseSourceRef(ref: string): Source {
  if (ref.startsWith("git:")) {
    const rest = ref.slice("git:".length);
    const hash = rest.lastIndexOf("#");
    if (hash > 0 && hash < rest.length - 1) {
      return {
        kind: "git",
        url: rest.slice(0, hash),
        ref: rest.slice(hash + 1),
      };
    }
    throw new Error("git source requires git:<url>#<ref>");
  }
  if (ref.startsWith("catalog:") || ref.startsWith("bundle:")) {
    throw new Error(
      "catalog: and bundle: are operator catalog sources; installer sources use git:, prepared:, or a local path",
    );
  }
  if (ref.startsWith("prepared:")) {
    const rest = ref.slice("prepared:".length);
    const hash = rest.lastIndexOf("#");
    if (hash > 0 && hash < rest.length - 1) {
      const digest = rest.slice(hash + 1);
      if (!SHA256_DIGEST_RE.test(digest)) {
        throw new Error(
          "prepared source digest must be sha256:<64 lowercase hex>",
        );
      }
      return {
        kind: "prepared",
        url: rest.slice(0, hash),
        digest,
      };
    }
    throw new Error("prepared source requires prepared:<url>#sha256:<hex>");
  }
  return { kind: "local", url: ref };
}

export function expectedPinFromOptions(
  options: ExpectedPinOptions,
): SourcePin | undefined {
  const hasCommit = options.expectedCommit !== undefined;
  const hasDigest = options.expectedPlanSnapshotDigest !== undefined;
  const hasSourceDigest = options.expectedSourceDigest !== undefined;
  if (!hasCommit && !hasDigest && !hasSourceDigest) return undefined;
  if (hasCommit && hasSourceDigest) {
    throw new Error(
      "--expected-commit and --expected-source-digest describe different source kinds",
    );
  }
  if (!hasDigest) {
    throw new Error(
      "--expected-plan-snapshot-digest is required when passing expected pins",
    );
  }
  if (hasCommit) {
    return {
      planSnapshotDigest: options.expectedPlanSnapshotDigest!,
      commit: options.expectedCommit!,
    };
  }
  if (hasSourceDigest) {
    return {
      planSnapshotDigest: options.expectedPlanSnapshotDigest!,
      sourceDigest: options.expectedSourceDigest!,
    };
  }
  return { planSnapshotDigest: options.expectedPlanSnapshotDigest! };
}

export function deploymentExpectedGuardFromOptions(
  options: DeploymentExpectedGuardOptions,
): DeploymentExpectedGuard | undefined {
  const sourcePin = expectedPinFromOptions(options);
  if (!sourcePin && options.expectedCurrentDeploymentId === undefined) {
    return undefined;
  }
  if (!sourcePin) {
    throw new Error(
      "--expected-plan-snapshot-digest is required when passing expected deploy guards",
    );
  }
  if (options.expectedCurrentDeploymentId === undefined) {
    throw new Error(
      "--expected-current-deployment-id is required when passing deploy expected guards",
    );
  }
  return {
    ...sourcePin,
    currentDeploymentId: options.expectedCurrentDeploymentId === "null"
      ? null
      : options.expectedCurrentDeploymentId,
  } as DeploymentExpectedGuard;
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
      "installer commands require a remote Takosumi service: pass --remote or set TAKOSUMI_REMOTE_URL",
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
  return await callTakosumiService({
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
