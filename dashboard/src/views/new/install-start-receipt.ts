import type { CreateGitInstallAttemptRequest } from "takosumi-contract";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isImmutableSourceRevision } from "../../lib/control-api.ts";

export interface ResolvedStoreVersion {
  readonly tag: string;
  readonly commit: string;
}

interface InstallStartReceipt {
  readonly key: string;
  readonly latest?: ResolvedStoreVersion;
}

/** The receipt matches an exact intent without storing the Git URL or input. */
export function installStartReceiptKey(
  scope: readonly [principalId: string, accountId: string, workspaceId: string | undefined],
  fromStore: boolean,
  request: CreateGitInstallAttemptRequest,
): string {
  const input = new TextEncoder().encode(JSON.stringify([scope, fromStore, request]));
  // Self-hosted HTTP sites can use sessionStorage without having crypto.subtle.
  return `takosumi.install-start:${bytesToHex(sha256(input))}`;
}

export function readInstallStartReceipt(storageKey: string): InstallStartReceipt | undefined {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return;
    const { key, latest } = JSON.parse(raw);
    if (typeof key !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(key)) return;
    if (latest === undefined) return { key };
    if (typeof latest?.tag !== "string" || !latest.tag || typeof latest.commit !== "string" ||
      !isImmutableSourceRevision(latest.commit)) return;
    return { key, latest: { tag: latest.tag, commit: latest.commit } };
  } catch {
    // Missing or unavailable browser storage does not prevent first install.
  }
}

export function retainInstallStartReceipt(storageKey: string, receipt: InstallStartReceipt): void {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(receipt));
  } catch {
    // Keep the live page's fallback key.
  }
}

export function releaseInstallStartReceipt(storageKey: string, key: string): void {
  if (readInstallStartReceipt(storageKey)?.key !== key) return;
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // The browser may revoke access after the receipt was read.
  }
}
