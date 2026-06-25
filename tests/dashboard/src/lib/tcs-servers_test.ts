import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  addTcsServer,
  getTcsServers,
  removeTcsServer,
} from "../../../../dashboard/src/lib/tcs-servers.ts";

const originalLocalStorage = globalThis.localStorage;

function createMemoryLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("TCS store server defaults", () => {
  beforeEach(() => {
    globalThis.localStorage = createMemoryLocalStorage();
  });

  afterEach(() => {
    if (originalLocalStorage) {
      globalThis.localStorage = originalLocalStorage;
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  test("uses the official Takosumi store by default", () => {
    expect(getTcsServers()).toEqual([
      { base: "https://store.takosumi.com", isDefault: true },
    ]);
  });

  test("still supports opt-in user-added stores", () => {
    expect(addTcsServer("https://store.example.com/")).toBe(
      "https://store.example.com",
    );
    expect(getTcsServers()).toEqual([
      { base: "https://store.takosumi.com", isDefault: true },
      { base: "https://store.example.com", isDefault: false },
    ]);

    removeTcsServer("https://store.example.com");
    expect(getTcsServers()).toEqual([
      { base: "https://store.takosumi.com", isDefault: true },
    ]);
  });
});
