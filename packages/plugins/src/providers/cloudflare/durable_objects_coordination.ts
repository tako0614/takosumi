import type { coordination } from "takosumi-contract";

export interface CloudflareDurableObjectsCoordinationClient {
  acquireLease(
    input: coordination.CoordinationLeaseInput,
  ): Promise<coordination.CoordinationLease>;
  renewLease(
    input: coordination.CoordinationRenewInput,
  ): Promise<coordination.CoordinationLease>;
  releaseLease(input: coordination.CoordinationReleaseInput): Promise<boolean>;
  getLease(scope: string): Promise<coordination.CoordinationLease | undefined>;
  scheduleAlarm(
    input: coordination.CoordinationAlarmInput,
  ): Promise<coordination.CoordinationAlarm>;
  cancelAlarm(id: string): Promise<boolean>;
  listAlarms(
    scope?: string,
  ): Promise<readonly coordination.CoordinationAlarm[]>;
}

export class CloudflareDurableObjectsCoordinationAdapter
  implements coordination.CoordinationPort {
  readonly #client: CloudflareDurableObjectsCoordinationClient;

  constructor(client: CloudflareDurableObjectsCoordinationClient) {
    this.#client = client;
  }

  acquireLease(
    input: coordination.CoordinationLeaseInput,
  ): Promise<coordination.CoordinationLease> {
    return this.#client.acquireLease(input);
  }

  renewLease(
    input: coordination.CoordinationRenewInput,
  ): Promise<coordination.CoordinationLease> {
    return this.#client.renewLease(input);
  }

  releaseLease(input: coordination.CoordinationReleaseInput): Promise<boolean> {
    return this.#client.releaseLease(input);
  }

  getLease(scope: string): Promise<coordination.CoordinationLease | undefined> {
    return this.#client.getLease(scope);
  }

  scheduleAlarm(
    input: coordination.CoordinationAlarmInput,
  ): Promise<coordination.CoordinationAlarm> {
    return this.#client.scheduleAlarm(input);
  }

  cancelAlarm(id: string): Promise<boolean> {
    return this.#client.cancelAlarm(id);
  }

  listAlarms(
    scope?: string,
  ): Promise<readonly coordination.CoordinationAlarm[]> {
    return this.#client.listAlarms(scope);
  }
}
