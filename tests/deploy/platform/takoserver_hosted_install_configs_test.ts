import { expect, test } from "bun:test";
import {
  TAKOSERVER_HOSTED_INSTALL_CONFIGS,
  TAKOSERVER_TAKOFORM_CONNECTION_ID,
  TAKOSERVER_TAKOFORM_PROVIDER_SOURCE,
} from "../../../deploy/platform/takoserver_hosted_install_configs.ts";
import * as hostedWorker from "../../../deploy/platform/takoserver_hosted_worker.ts";

test("Takosumi Hosted offers one explicit Takoserver or Takoform choice", () => {
  expect(TAKOSERVER_HOSTED_INSTALL_CONFIGS).toHaveLength(2);
  const [managed, byoc] = TAKOSERVER_HOSTED_INSTALL_CONFIGS;
  expect(managed?.store?.deploymentProfile).toMatchObject({
    key: "takoserver-v1",
    label: { ja: "Takoserver", en: "Takoserver" },
    recommended: true,
  });
  expect(byoc?.store?.deploymentProfile).toMatchObject({
    key: "takoform-v1",
    label: { ja: "Takoform", en: "Takoform" },
    recommended: false,
  });
  for (const config of TAKOSERVER_HOSTED_INSTALL_CONFIGS) {
    expect(config.sourceSelector).toEqual({
      url: "https://github.com/tako0614/yurucommu.git",
      path: ".",
    });
    expect(config.modulePath).toBe("deploy/takoform-current");
    expect(config.policy.allowedProviders).toEqual([
      TAKOSERVER_TAKOFORM_PROVIDER_SOURCE,
    ]);
    expect(config.policy.providerCredentials?.requiredProviders).toEqual([
      TAKOSERVER_TAKOFORM_PROVIDER_SOURCE,
    ]);
  }
  expect(managed?.policy.providerCredentials).toMatchObject({
    allowedConnectionIds: [TAKOSERVER_TAKOFORM_CONNECTION_ID],
    requireTemporary: true,
    requireTtlEnforced: true,
  });
  expect(byoc?.policy.providerCredentials).toMatchObject({
    forbiddenConnectionIds: [TAKOSERVER_TAKOFORM_CONNECTION_ID],
  });
});

test("Takoserver Hosted wrapper preserves every Worker Durable Object export", () => {
  expect(typeof hostedWorker.CoordinationObject).toBe("function");
  expect(typeof hostedWorker.LocalSubstrateOpenTofuRunnerProxyObject).toBe(
    "function",
  );
  expect(typeof hostedWorker.OpenTofuRunOwnerObject).toBe("function");
  expect(typeof hostedWorker.OpenTofuRunnerObject).toBe("function");
});
