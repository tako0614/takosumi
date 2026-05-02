export type IsoTimestamp = string;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function toIsoTimestamp(date: Date): IsoTimestamp {
  return date.toISOString();
}

export function nowIso(clock: Clock = systemClock): IsoTimestamp {
  return toIsoTimestamp(clock.now());
}
