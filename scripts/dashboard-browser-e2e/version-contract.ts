/**
 * Small pure assertions shared by the live dashboard runner and its harness
 * tests. The contract deliberately carries only route/status/version data;
 * browser storage and session material never enters evidence.
 */
export function assertExpectedRouteStatus(input: {
  readonly route: string;
  readonly expectedStatus: number;
  readonly observedStatus: number;
}): void {
  if (input.observedStatus !== input.expectedStatus) {
    throw new Error(
      `${input.route}: expected status ${input.expectedStatus}, observed ${input.observedStatus}`,
    );
  }
}

export function assertExpectedWorkerVersionId(input: {
  readonly route: string;
  readonly expectedWorkerVersionId: string;
  readonly observedWorkerVersionId: string | null | undefined;
}): void {
  const observed = input.observedWorkerVersionId?.trim() || "";
  if (!observed) {
    throw new Error(`${input.route}: missing x-takosumi-version-id`);
  }
  if (observed !== input.expectedWorkerVersionId) {
    throw new Error(
      `${input.route}: expected x-takosumi-version-id ${input.expectedWorkerVersionId}, observed ${observed}`,
    );
  }
}
