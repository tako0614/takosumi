import { expect, test } from "bun:test";
import {
  DatabaseBootMigrationConfigurationError,
  resolveDatabaseBootMigrationMode,
} from "../../core/index.ts";

test("production and staging startup only verify predeployed migrations", () => {
  expect(
    resolveDatabaseBootMigrationMode({ TAKOSUMI_ENVIRONMENT: "production" }),
  ).toBe("verify");
  expect(
    resolveDatabaseBootMigrationMode({
      TAKOSUMI_ENVIRONMENT: "staging",
      TAKOSUMI_DB_AUTO_MIGRATE: "false",
    }),
  ).toBe("verify");
  expect(
    resolveDatabaseBootMigrationMode({ ENVIRONMENT: "production" }),
  ).toBe("verify");
});

test("production-like startup rejects boot-time migration opt-in", () => {
  for (const environment of ["production", "staging"]) {
    expect(() =>
      resolveDatabaseBootMigrationMode({
        TAKOSUMI_ENVIRONMENT: environment,
        TAKOSUMI_DB_AUTO_MIGRATE: "true",
      })
    ).toThrow(DatabaseBootMigrationConfigurationError);
  }
});

test("local development requires explicit opt-in before applying migrations", () => {
  expect(resolveDatabaseBootMigrationMode({})).toBe("verify");
  expect(
    resolveDatabaseBootMigrationMode({
      TAKOSUMI_ENVIRONMENT: "development",
      TAKOSUMI_DB_AUTO_MIGRATE: "false",
    }),
  ).toBe("verify");
  expect(
    resolveDatabaseBootMigrationMode({
      TAKOSUMI_ENVIRONMENT: "development",
      TAKOSUMI_DB_AUTO_MIGRATE: "true",
    }),
  ).toBe("apply");
});

test("database auto-migrate flag rejects ambiguous values", () => {
  expect(() =>
    resolveDatabaseBootMigrationMode({
      TAKOSUMI_DB_AUTO_MIGRATE: "yes",
    })
  ).toThrow("TAKOSUMI_DB_AUTO_MIGRATE must be true or false");
});
