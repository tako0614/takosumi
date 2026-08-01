/**
 * Provider-neutral five-field cron contract.
 *
 * The expression is evaluated against UTC calendar fields.  This module does
 * not interpret timezone identifiers; a host that accepts a timezone must
 * make that decision before calling these helpers.
 *
 * The day-of-month/day-of-week rule follows the traditional cron contract:
 * when both fields are restricted (neither is the literal `*`), a date is a
 * match when either field matches.  When either field is unrestricted, both
 * field predicates must match.  Day-of-week accepts both `0` and `7` for
 * Sunday; its normalized representation uses `0`.
 */

const MINUTE_MS = 60_000;
const MAX_SEARCH_DAYS = 5 * 366 + 1;

type CronFieldIndex = 0 | 1 | 2 | 3 | 4;

interface ParsedCronField {
  readonly values: ReadonlySet<number>;
  readonly normalized: string;
  /** True only when the field is the literal wildcard (not a stepped wildcard). */
  readonly unrestricted: boolean;
}

interface ParsedCron {
  readonly normalized: string;
  readonly minute: ParsedCronField;
  readonly hour: ParsedCronField;
  readonly dayOfMonth: ParsedCronField;
  readonly month: ParsedCronField;
  readonly dayOfWeek: ParsedCronField;
}

const FIELD_RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** Normalize and validate a portable five-field cron expression. */
export function normalizePortableCron(expression: string): string {
  return parsePortableCron(expression).normalized;
}

/** Match a UTC instant at minute granularity against a portable cron expression. */
export function matchesPortableCron(expression: string, at: Date): boolean {
  const parsed = parsePortableCron(expression);
  assertValidDate(at);
  return matchesParsedCron(parsed, at);
}

/**
 * Find the first UTC minute strictly after `after` that matches the
 * expression.  The search is bounded to a little over five calendar years so
 * malformed-but-well-shaped schedules (for example, 31 February) cannot make
 * a caller spin forever.  A valid expression with no occurrence in that
 * window raises a RangeError.
 */
export function nextPortableCronOccurrence(
  expression: string,
  after: Date,
): Date {
  const parsed = parsePortableCron(expression);
  assertValidDate(after);

  const afterMs = after.getTime();
  const initialMinute = new Date(afterMs);
  initialMinute.setUTCSeconds(0, 0);
  const initialDay = new Date(initialMinute);
  initialDay.setUTCHours(0, 0, 0, 0);

  const initialHour = initialMinute.getUTCHours();
  const initialMinuteValue = initialMinute.getUTCMinutes();

  const hours = [...parsed.hour.values].sort((left, right) => left - right);
  const minutes = [...parsed.minute.values].sort(
    (left, right) => left - right,
  );

  for (let dayOffset = 0; dayOffset <= MAX_SEARCH_DAYS; dayOffset += 1) {
    const day = new Date(initialDay.getTime() + dayOffset * 24 * 60 * MINUTE_MS);
    if (!Number.isFinite(day.getTime())) break;
    if (!parsed.month.values.has(day.getUTCMonth() + 1)) continue;
    if (!matchesCronDay(parsed, day)) continue;

    for (const hour of hours) {
      if (dayOffset === 0 && hour < initialHour) continue;
      for (const minute of minutes) {
        if (
          dayOffset === 0 &&
          (hour < initialHour ||
            (hour === initialHour && minute <= initialMinuteValue))
        ) {
          continue;
        }
        const candidate = new Date(0);
        candidate.setUTCFullYear(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
        );
        candidate.setUTCHours(hour, minute, 0, 0);
        if (candidate.getTime() <= afterMs) continue;
        return candidate;
      }
    }
  }

  throw new RangeError(
    "portable cron has no occurrence within the bounded five-year search window",
  );
}

function parsePortableCron(expression: string): ParsedCron {
  if (typeof expression !== "string") {
    throw new TypeError("portable cron expression must be a string");
  }
  const source = expression.trim();
  if (source.length === 0 || source.length > 1_024) {
    throw new TypeError("portable cron expression must be non-empty and bounded");
  }
  const rawFields = source.split(/\s+/u);
  if (rawFields.length !== 5) {
    throw new TypeError("portable cron expression must contain five fields");
  }

  const fields = rawFields.map((field, index) =>
    parseCronField(field, index as CronFieldIndex),
  ) as [
    ParsedCronField,
    ParsedCronField,
    ParsedCronField,
    ParsedCronField,
    ParsedCronField,
  ];
  return {
    normalized: fields.map((field) => field.normalized).join(" "),
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  };
}

function parseCronField(
  source: string,
  fieldIndex: CronFieldIndex,
): ParsedCronField {
  const [minimum, maximum] = FIELD_RANGES[fieldIndex]!;
  const parts = source.split(",");
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw invalidField(fieldIndex);
  }

  const values = new Set<number>();
  const normalizedParts: string[] = [];
  const normalizedPartSet = new Set<string>();
  let unrestricted = false;

  for (const part of parts) {
    const slashParts = part.split("/");
    if (slashParts.length > 2 || slashParts.some((item) => item.length === 0)) {
      throw invalidField(fieldIndex);
    }
    const base = slashParts[0]!;
    const step =
      slashParts.length === 2
        ? parsePositiveInteger(slashParts[1]!, fieldIndex)
        : 1;
    const isWildcard = base === "*";

    let start: number;
    let end: number;
    let range = false;
    if (isWildcard) {
      start = minimum;
      end = maximum;
      unrestricted = unrestricted || slashParts.length === 1;
    } else if (/^\d+$/u.test(base)) {
      start = parseBoundedInteger(base, minimum, maximum, fieldIndex);
      end = slashParts.length === 2 ? maximum : start;
    } else if (/^\d+-\d+$/u.test(base)) {
      const [startText, endText] = base.split("-");
      start = parseBoundedInteger(startText!, minimum, maximum, fieldIndex);
      end = parseBoundedInteger(endText!, minimum, maximum, fieldIndex);
      if (start > end) throw invalidField(fieldIndex);
      range = true;
    } else {
      throw invalidField(fieldIndex);
    }

    const itemValues: number[] = [];
    for (let value = start; value <= end; value += step) {
      const normalizedValue = fieldIndex === 4 && value === 7 ? 0 : value;
      values.add(normalizedValue);
      itemValues.push(normalizedValue);
      if (value > maximum - step) break;
    }

    let normalizedPart: string;
    if (fieldIndex === 4 && (start === 7 || end === 7)) {
      // A DOW range ending in 7 includes Sunday.  Expanding this one edge
      // case avoids producing an invalid canonical range such as `5-0`.
      normalizedPart = uniqueNumbers(itemValues).join(",");
    } else if (isWildcard) {
      normalizedPart = slashParts.length === 1 ? "*" : `*/${step}`;
    } else if (range) {
      normalizedPart = `${start}-${end}${step === 1 ? "" : `/${step}`}`;
    } else {
      const normalizedStart = fieldIndex === 4 && start === 7 ? 0 : start;
      if (slashParts.length === 2 && fieldIndex === 4 && start === 7) {
        normalizedPart = String(normalizedStart);
      } else {
        normalizedPart = `${normalizedStart}${
          slashParts.length === 2 ? `/${step}` : ""
        }`;
      }
    }

    for (const normalized of normalizedPart.split(",")) {
      if (!normalizedPartSet.has(normalized)) {
        normalizedPartSet.add(normalized);
        normalizedParts.push(normalized);
      }
    }
  }

  return {
    values,
    normalized: normalizedParts.join(","),
    unrestricted,
  };
}

function parsePositiveInteger(value: string, fieldIndex: CronFieldIndex): number {
  if (!/^\d+$/u.test(value)) throw invalidField(fieldIndex);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidField(fieldIndex);
  }
  return parsed;
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  fieldIndex: CronFieldIndex,
): number {
  if (!/^\d+$/u.test(value)) throw invalidField(fieldIndex);
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw invalidField(fieldIndex);
  }
  return parsed;
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}

function invalidField(fieldIndex: CronFieldIndex): TypeError {
  const names = ["minute", "hour", "day-of-month", "month", "day-of-week"];
  return new TypeError(`invalid portable cron ${names[fieldIndex]} field`);
}

function matchesParsedCron(parsed: ParsedCron, at: Date): boolean {
  return (
    parsed.minute.values.has(at.getUTCMinutes()) &&
    parsed.hour.values.has(at.getUTCHours()) &&
    parsed.month.values.has(at.getUTCMonth() + 1) &&
    matchesCronDay(parsed, at)
  );
}

function matchesCronDay(parsed: ParsedCron, at: Date): boolean {
  const dayOfMonthMatches = parsed.dayOfMonth.values.has(at.getUTCDate());
  const dayOfWeekMatches = parsed.dayOfWeek.values.has(at.getUTCDay());
  if (!parsed.dayOfMonth.unrestricted && !parsed.dayOfWeek.unrestricted) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("UTC cron matcher requires a valid Date");
  }
}
