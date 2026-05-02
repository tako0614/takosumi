import type { JsonObject } from "takosumi-contract";

export interface CoordinationLease {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly acquired: boolean;
  readonly expiresAt: string;
  readonly metadata?: JsonObject;
}

export interface CoordinationLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly ttlMs: number;
  readonly metadata?: JsonObject;
}

export interface CoordinationRenewInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly ttlMs: number;
}

export interface CoordinationReleaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
}

export interface CoordinationAlarm {
  readonly id: string;
  readonly scope: string;
  readonly fireAt: string;
  readonly payload?: JsonObject;
}

export interface CoordinationAlarmInput {
  readonly id: string;
  readonly scope: string;
  readonly fireAt: string;
  readonly payload?: JsonObject;
}

export interface CoordinationPort {
  acquireLease(input: CoordinationLeaseInput): Promise<CoordinationLease>;
  renewLease(input: CoordinationRenewInput): Promise<CoordinationLease>;
  releaseLease(input: CoordinationReleaseInput): Promise<boolean>;
  getLease(scope: string): Promise<CoordinationLease | undefined>;
  scheduleAlarm(input: CoordinationAlarmInput): Promise<CoordinationAlarm>;
  cancelAlarm(id: string): Promise<boolean>;
  listAlarms(scope?: string): Promise<readonly CoordinationAlarm[]>;
}
