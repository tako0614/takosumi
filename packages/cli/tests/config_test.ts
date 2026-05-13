import assert from "node:assert/strict";
import {
  __resetConfigFileCacheForTesting,
  loadConfig,
  resolveMode,
} from "../src/config.ts";

Deno.test("resolveMode prefers explicit --remote flag", () => {
  const result = resolveMode(
    { remote: "https://kernel.local", token: "t1" },
    { kernelUrl: "https://config.local", token: "tcfg" },
  );
  assert.deepEqual(result, {
    mode: "remote",
    url: "https://kernel.local",
    token: "t1",
  });
});

Deno.test("resolveMode falls back to config kernelUrl", () => {
  const result = resolveMode(
    {},
    { kernelUrl: "https://config.local", token: "tcfg" },
  );
  assert.deepEqual(result, {
    mode: "remote",
    url: "https://config.local",
    token: "tcfg",
  });
});

Deno.test("resolveMode returns local when no URL configured", () => {
  const result = resolveMode({}, {});
  assert.deepEqual(result, { mode: "local" });
});

Deno.test("loadConfig reads ~/.takosumi/config.yml when env unset", async () => {
  const dir = await Deno.makeTempDir({ prefix: "takosumi-cfg-" });
  try {
    const path = `${dir}/config.yml`;
    await Deno.writeTextFile(
      path,
      "remote_url: https://from-file.local\ntoken: file-token\n",
    );

    const previousFile = Deno.env.get("TAKOSUMI_CONFIG_FILE");
    const previousRemote = Deno.env.get("TAKOSUMI_REMOTE_URL");
    const previousDeployToken = Deno.env.get("TAKOSUMI_DEPLOY_TOKEN");
    Deno.env.set("TAKOSUMI_CONFIG_FILE", path);
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
    __resetConfigFileCacheForTesting();
    try {
      const config = await loadConfig();
      assert.equal(config.kernelUrl, "https://from-file.local");
      assert.equal(config.token, "file-token");
    } finally {
      if (previousFile === undefined) {
        Deno.env.delete("TAKOSUMI_CONFIG_FILE");
      } else {
        Deno.env.set("TAKOSUMI_CONFIG_FILE", previousFile);
      }
      if (previousRemote !== undefined) {
        Deno.env.set("TAKOSUMI_REMOTE_URL", previousRemote);
      }
      if (previousDeployToken !== undefined) {
        Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", previousDeployToken);
      }
      __resetConfigFileCacheForTesting();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfig env wins over config file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "takosumi-cfg-" });
  try {
    const path = `${dir}/config.yml`;
    await Deno.writeTextFile(
      path,
      "remote_url: https://from-file.local\ntoken: file-token\n",
    );

    const previousFile = Deno.env.get("TAKOSUMI_CONFIG_FILE");
    const previousRemote = Deno.env.get("TAKOSUMI_REMOTE_URL");
    const previousDeployToken = Deno.env.get("TAKOSUMI_DEPLOY_TOKEN");
    Deno.env.set("TAKOSUMI_CONFIG_FILE", path);
    Deno.env.set("TAKOSUMI_REMOTE_URL", "https://from-env.local");
    Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", "env-token");
    __resetConfigFileCacheForTesting();
    try {
      const config = await loadConfig();
      assert.equal(config.kernelUrl, "https://from-env.local");
      assert.equal(config.token, "env-token");
    } finally {
      if (previousFile === undefined) {
        Deno.env.delete("TAKOSUMI_CONFIG_FILE");
      } else {
        Deno.env.set("TAKOSUMI_CONFIG_FILE", previousFile);
      }
      if (previousRemote === undefined) {
        Deno.env.delete("TAKOSUMI_REMOTE_URL");
      } else {
        Deno.env.set("TAKOSUMI_REMOTE_URL", previousRemote);
      }
      if (previousDeployToken === undefined) {
        Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
      } else {
        Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", previousDeployToken);
      }
      __resetConfigFileCacheForTesting();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadConfig returns empty when neither env nor file present", async () => {
  const dir = await Deno.makeTempDir({ prefix: "takosumi-cfg-" });
  try {
    const path = `${dir}/missing-config.yml`;
    const previousFile = Deno.env.get("TAKOSUMI_CONFIG_FILE");
    const previousRemote = Deno.env.get("TAKOSUMI_REMOTE_URL");
    const previousDeployToken = Deno.env.get("TAKOSUMI_DEPLOY_TOKEN");
    Deno.env.set("TAKOSUMI_CONFIG_FILE", path);
    Deno.env.delete("TAKOSUMI_REMOTE_URL");
    Deno.env.delete("TAKOSUMI_DEPLOY_TOKEN");
    __resetConfigFileCacheForTesting();
    try {
      const config = await loadConfig();
      assert.equal(config.kernelUrl, undefined);
      assert.equal(config.token, undefined);
    } finally {
      if (previousFile === undefined) {
        Deno.env.delete("TAKOSUMI_CONFIG_FILE");
      } else {
        Deno.env.set("TAKOSUMI_CONFIG_FILE", previousFile);
      }
      if (previousRemote !== undefined) {
        Deno.env.set("TAKOSUMI_REMOTE_URL", previousRemote);
      }
      if (previousDeployToken !== undefined) {
        Deno.env.set("TAKOSUMI_DEPLOY_TOKEN", previousDeployToken);
      }
      __resetConfigFileCacheForTesting();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
