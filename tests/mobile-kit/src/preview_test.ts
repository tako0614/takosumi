import { expect, test } from "bun:test";
import {
  appendUniqueMobileItemsByKey,
  appendUniqueMobileItemsById,
  formatMobilePreviewDate,
  prependUniqueMobileItemsByKey,
} from "../../../mobile-kit/src/index.ts";

test("formatMobilePreviewDate formats valid timestamps and preserves invalid input", () => {
  expect(
    formatMobilePreviewDate("2026-07-01T12:34:00.000Z", "en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  ).toBe("Jul 1, 12:34 PM");
  expect(formatMobilePreviewDate("not-a-date")).toBe("not-a-date");
});

test("appendUniqueMobileItemsById appends unseen ids without changing existing order", () => {
  const current = [
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
  ];
  const next = [
    { id: "two", label: "Two duplicate" },
    { id: "three", label: "Three" },
    { id: "one", label: "One duplicate" },
    { id: "four", label: "Four" },
  ];

  expect(appendUniqueMobileItemsById(current, next)).toEqual([
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
    { id: "three", label: "Three" },
    { id: "four", label: "Four" },
  ]);
  expect(appendUniqueMobileItemsById(current, [])).toBe(current);
});

test("appendUniqueMobileItemsByKey appends unseen keys from a custom key function", () => {
  const current = [
    { role: "assistant", createdAt: "2026-07-01T10:00:00.000Z", text: "A" },
  ];
  const next = [
    { role: "assistant", createdAt: "2026-07-01T10:00:00.000Z", text: "A" },
    { role: "user", createdAt: "2026-07-01T10:01:00.000Z", text: "B" },
  ];

  expect(
    appendUniqueMobileItemsByKey(
      current,
      next,
      (item) => `${item.role}:${item.createdAt}:${item.text}`,
    ),
  ).toEqual([
    { role: "assistant", createdAt: "2026-07-01T10:00:00.000Z", text: "A" },
    { role: "user", createdAt: "2026-07-01T10:01:00.000Z", text: "B" },
  ]);
});

test("prependUniqueMobileItemsByKey prepends older unseen keys", () => {
  const current = [
    { id: "two", label: "Two" },
    { id: "three", label: "Three" },
  ];
  const older = [
    { id: "one", label: "One" },
    { id: "two", label: "Two duplicate" },
  ];

  expect(
    prependUniqueMobileItemsByKey(older, current, (item) => item.id),
  ).toEqual([
    { id: "one", label: "One" },
    { id: "two", label: "Two" },
    { id: "three", label: "Three" },
  ]);
  expect(prependUniqueMobileItemsByKey([], current, (item) => item.id)).toBe(
    current,
  );
});
