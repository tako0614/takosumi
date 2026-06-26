/**
 * Binding-resolution helper shapes consumed by the resources domain
 * (per-binding resolution input + value-level resolution snapshot) and the
 * shared scalar enums they reference.
 *
 * Relocated from the retired `takosumi-v1.ts` reference umbrella; only the
 * shapes that are actually consumed by service code are kept.
 */

import type { IsoTimestamp } from "./types.ts";

export type CoreSensitivity = "public" | "internal" | "secret" | "credential";
export type CoreEnforcement = "enforced" | "advisory" | "unsupported";
export type CoreBindingSource =
  | "resource"
  | "output"
  | "secret"
  | "provider-output";

export interface CoreAccessModeRef {
  contract: string;
  mode: string;
}

export interface CoreInjectionTarget {
  mode: string;
  target: string;
}

export interface CoreBindingResolutionInput {
  bindingName: string;
  source: CoreBindingSource;
  sourceAddress: string;
  access?: CoreAccessModeRef;
  injection: CoreInjectionTarget;
  sensitivity: CoreSensitivity;
  enforcement: CoreEnforcement;
}

export interface CoreBindingValueResolution {
  bindingSetRevisionId: string;
  bindingName: string;
  sourceAddress: string;
  resolutionPolicy:
    | "latest-at-activation"
    | "pinned-version"
    | "latest-at-invocation";
  resolvedVersion?: string;
  resolvedAt: IsoTimestamp;
  sensitivity: CoreSensitivity;
}
