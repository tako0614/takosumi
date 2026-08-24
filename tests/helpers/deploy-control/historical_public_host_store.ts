import type {
  OpenTofuControlStore,
  PublicHostReservation,
} from "../../../core/domains/deploy-control/store.ts";

/**
 * Test-only read/drain view over rows written by the retired hostname allocator.
 * It deliberately exposes no reservation creation method.
 */
export function withHistoricalPublicHostReservations(
  delegate: OpenTofuControlStore,
  reservations: readonly PublicHostReservation[],
  options: {
    readonly onRelease?: (capsuleId: string, now: string) => void;
  } = {},
): OpenTofuControlStore {
  const rows = new Map(
    reservations.map((reservation) => [
      reservation.hostname.toLowerCase(),
      reservation,
    ]),
  );

  return new Proxy(delegate, {
    get(target, property) {
      if (property === "getPublicHostReservation") {
        return (hostname: string) =>
          Promise.resolve(rows.get(hostname.toLowerCase()));
      }
      if (property === "releasePublicHostsForCapsule") {
        return (capsuleId: string, now: string) => {
          options.onRelease?.(capsuleId, now);
          for (const [hostname, reservation] of rows) {
            if (
              reservation.capsuleId !== capsuleId ||
              reservation.status !== "reserved"
            ) {
              continue;
            }
            rows.set(hostname, {
              ...reservation,
              status: "released",
              updatedAt: now,
              releasedAt: now,
            });
          }
          return Promise.resolve();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
