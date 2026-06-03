import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetConfigFileCacheForTesting,
  loadConfig,
  resolveMode,
} from "../config.ts";

test("resolveMode prefers explicit --remote flag", () => {
  const result = resolveMode(
    { remote: "https://service.local", token: "t1" },
    { serviceUrl: "https://config.local", token: "tcfg" },
  );
  assert.deepEqual(result, {
    mode: "remote",
    url: "https://service.local",
    token: "t1",
  });
});

test("resolveMode falls back to config serviceUrl", () => {
  const result = resolveMode(
    {},
    { serviceUrl: "https://config.local", token: "tcfg" },
  );
  assert.deepEqual(result, {
    mode: "remote",
    url: "https://config.local",
    token: "tcfg",
  });
});

test("resolveMode returns local when no URL configured", () => {
  const result = resolveMode({}, {});
  assert.deepEqual(result, { mode: "local" });
});

test("loadConfig reads configured YAML file when env unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-cfg-"));
  try {
    const path = `${dir}/config.yml`;
    await writeFile(
      path,
      "remote_url: https://from-file.local\ntoken: file-token\n",
    );

    const previousFile = process.env["TAKOSUMI_CONFIG_FILE"];
    const previousRemote = process.env["TAKOSUMI_REMOTE_URL"];
    const previousDeployControlToken = process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
    process.env["TAKOSUMI_CONFIG_FILE"] = path;
    delete process.env["TAKOSUMI_REMOTE_URL"];
    delete process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
    __resetConfigFileCacheForTesting();
    try {
      const config = await loadConfig();
      assert.equal(config.serviceUrl, "https://from-file.local");
      assert.equal(config.token, "file-token");
    } finally {
      if (previousFile === undefined) {
        delete process.env["TAKOSUMI_CONFIG_FILE"];
      } else {
        process.env["TAKOSUMI_CONFIG_FILE"] = previousFile;
      }
      if (previousRemote !== undefined) {
        process.env["TAKOSUMI_REMOTE_URL"] = previousRemote;
      }
      if (previousDeployControlToken !== undefined) {
        process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"] = previousDeployControlToken;
      }
      __resetConfigFileCacheForTesting();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig env wins over config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-cfg-"));
  try {
    const path = `${dir}/config.yml`;
    await writeFile(
      path,
      "remote_url: https://from-file.local\ntoken: file-token\n",
    );

    const previousFile = process.env["TAKOSUMI_CONFIG_FILE"];
    const previousRemote = process.env["TAKOSUMI_REMOTE_URL"];
    const previousDeployControlToken = process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
    process.env["TAKOSUMI_CONFIG_FILE"] = path;
    process.env["TAKOSUMI_REMOTE_URL"] = "https://from-env.local";
    process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"] = "env-token";
    __resetConfigFileCacheForTesting();
    try {
      const config = await loadConfig();
      assert.equal(config.serviceUrl, "https://from-env.local");
      assert.equal(config.token, "env-token");
    } finally {
      if (previousFile === undefined) {
        delete process.env["TAKOSUMI_CONFIG_FILE"];
      } else {
        process.env["TAKOSUMI_CONFIG_FILE"] = previousFile;
      }
      if (previousRemote === undefined) {
        delete process.env["TAKOSUMI_REMOTE_URL"];
      } else {
        process.env["TAKOSUMI_REMOTE_URL"] = previousRemote;
      }
      if (previousDeployControlToken === undefined) {
        delete process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
      } else {
        process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"] = previousDeployControlToken;
      }
      __resetConfigFileCacheForTesting();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig returns empty when neither env nor file present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-cfg-"));
  try {
    const path = `${dir}/missing-config.yml`;
    const previousFile = process.env["TAKOSUMI_CONFIG_FILE"];
    const previousRemote = process.env["TAKOSUMI_REMOTE_URL"];
    const previousDeployControlToken = process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
    process.env["TAKOSUMI_CONFIG_FILE"] = path;
    delete process.env["TAKOSUMI_REMOTE_URL"];
    delete process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
    __resetConfigFileCacheForTesting();
    try {
      const config = await loadConfig();
      assert.equal(config.serviceUrl, undefined);
      assert.equal(config.token, undefined);
    } finally {
      if (previousFile === undefined) {
        delete process.env["TAKOSUMI_CONFIG_FILE"];
      } else {
        process.env["TAKOSUMI_CONFIG_FILE"] = previousFile;
      }
      if (previousRemote !== undefined) {
        process.env["TAKOSUMI_REMOTE_URL"] = previousRemote;
      }
      if (previousDeployControlToken !== undefined) {
        process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"] = previousDeployControlToken;
      }
      __resetConfigFileCacheForTesting();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig ignores legacy deploy token env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "takosumi-cfg-"));
  try {
    const path = `${dir}/missing-config.yml`;
    const previousFile = process.env["TAKOSUMI_CONFIG_FILE"];
    const previousRemote = process.env["TAKOSUMI_REMOTE_URL"];
    const previousDeployControlToken = process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
    const previousDeployToken = process.env["TAKOSUMI_DEPLOY_TOKEN"];
    process.env["TAKOSUMI_CONFIG_FILE"] = path;
    process.env["TAKOSUMI_REMOTE_URL"] = "https://from-env.local";
    delete process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
    process.env["TAKOSUMI_DEPLOY_TOKEN"] = "legacy-deploy-token";
    __resetConfigFileCacheForTesting();
    try {
      const config = await loadConfig();
      assert.equal(config.serviceUrl, "https://from-env.local");
      assert.equal(config.token, undefined);
    } finally {
      if (previousFile === undefined) {
        delete process.env["TAKOSUMI_CONFIG_FILE"];
      } else {
        process.env["TAKOSUMI_CONFIG_FILE"] = previousFile;
      }
      if (previousRemote === undefined) {
        delete process.env["TAKOSUMI_REMOTE_URL"];
      } else {
        process.env["TAKOSUMI_REMOTE_URL"] = previousRemote;
      }
      if (previousDeployControlToken === undefined) {
        delete process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"];
      } else {
        process.env["TAKOSUMI_DEPLOY_CONTROL_TOKEN"] =
          previousDeployControlToken;
      }
      if (previousDeployToken === undefined) {
        delete process.env["TAKOSUMI_DEPLOY_TOKEN"];
      } else {
        process.env["TAKOSUMI_DEPLOY_TOKEN"] = previousDeployToken;
      }
      __resetConfigFileCacheForTesting();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
