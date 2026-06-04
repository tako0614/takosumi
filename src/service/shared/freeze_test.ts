import { expect, test } from "bun:test";

import { freeze, freezeClone, immutable } from "./freeze.ts";

test("freeze deeply freezes nested objects and arrays in place", () => {
  const value = { a: { b: 1 }, list: [{ c: 2 }] };
  const frozen = freeze(value);

  expect(frozen).toBe(value);
  expect(Object.isFrozen(frozen)).toBeTruthy();
  expect(Object.isFrozen(frozen.a)).toBeTruthy();
  expect(Object.isFrozen(frozen.list)).toBeTruthy();
  expect(Object.isFrozen(frozen.list[0])).toBeTruthy();
});

test("freezeClone returns a frozen deep copy independent of the source", () => {
  const source = { roles: ["owner"], nested: { value: 1 } };
  const cloned = freezeClone(source);

  expect(cloned).not.toBe(source);
  expect(cloned.roles).not.toBe(source.roles);
  expect(Object.isFrozen(cloned)).toBeTruthy();
  expect(Object.isFrozen(cloned.roles)).toBeTruthy();
  expect(Object.isFrozen(cloned.nested)).toBeTruthy();

  // Mutating the source after cloning must not affect the frozen copy.
  source.roles.push("admin");
  source.nested.value = 99;
  expect([...cloned.roles]).toEqual(["owner"]);
  expect(cloned.nested.value).toBe(1);
});

test("immutable is an alias of freezeClone", () => {
  expect(immutable).toBe(freezeClone);
});

test("freeze does not recurse into typed-array (ArrayBuffer.isView) payloads", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const payload = { digest: bytes };
  const frozen = freeze(payload);

  // The wrapper object is frozen, but the typed-array view is returned as-is
  // rather than recursed into / frozen element by element.
  expect(Object.isFrozen(frozen)).toBeTruthy();
  expect(Object.isFrozen(frozen.digest)).toBeFalsy();
  expect(frozen.digest).toBe(bytes);
});

test("freeze returns a bare typed array unchanged", () => {
  const bytes = new Uint8Array([4, 5, 6]);
  expect(freeze(bytes)).toBe(bytes);
  expect(Object.isFrozen(bytes)).toBeFalsy();
});
