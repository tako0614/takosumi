import { expect, test } from "bun:test";
import {
  commandContextFromRequest,
  redactRunnerOutput,
} from "../../../runner/entrypoint.ts";

// Runner profile policy is independent of the CredentialRecipe payload.
const CLOUDFLARE_PROFILE = {
  id: "opentofu-default",
  allowedProviders: ["cloudflare/cloudflare"],
};

const REQUEST = {
  planRun: {
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  },
};

function requestWithCredentials(
  env: Readonly<Record<string, string>>,
  envNames: readonly string[] = Object.keys(env).filter(
    (name) => /^[A-Z][A-Z0-9_]*$/u.test(name) && !name.startsWith("TF_VAR_"),
  ),
) {
  return {
    ...REQUEST,
    credentials: {
      env,
      manifest: {
        bindings: [
          {
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            connectionId: "conn_fixture",
            recipeId: "generic-env",
            authMode: "env",
            envNames,
            fileEnvNames: [],
            requiredEnvGroups: [],
          },
        ],
      },
    },
  };
}

test("generic-env provider payload credentials are admitted", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(
      requestWithCredentials({ CLOUDFLARE_API_TOKEN: "payload-token" }),
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toBe("payload-token");
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("does not fall back to Bun.env by default when the payload omits the credential", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(REQUEST, CLOUDFLARE_PROFILE);
    expect(context.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("does not fall back to Bun.env even for a local-dev runner profile", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(REQUEST, {
      ...CLOUDFLARE_PROFILE,
      devLocalAllowAmbientCredentials: true,
    });
    expect(context.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("generic-env provider payload admits upper-snake env and rejects invalid names", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  delete Bun.env.CLOUDFLARE_API_TOKEN;
  try {
    const context = commandContextFromRequest(
      requestWithCredentials({
        CLOUDFLARE_API_TOKEN: "payload-token",
        // Another declared provider env supplied by the control plane payload.
        AWS_SECRET_ACCESS_KEY: "payload-aws-secret",
        // Invalid env-name shape; must be ignored.
        "lower-case": "nope",
      }),
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toBe("payload-token");
    expect(context.env.AWS_SECRET_ACCESS_KEY).toBe("payload-aws-secret");
    expect(context.env["lower-case"]).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("TF_VAR credentials are rejected even when supplied by the payload", () => {
  const context = commandContextFromRequest(
    requestWithCredentials({
      CLOUDFLARE_API_TOKEN: "shared-token",
      TF_VAR_cloudflare_main_api_token: "per-alias-compute-token",
      TF_VAR_cloudflare_dns_api_token: "per-alias-dns-token",
    }),
    CLOUDFLARE_PROFILE,
  );
  expect(context.env.CLOUDFLARE_API_TOKEN).toEqual("shared-token");
  expect(context.env.TF_VAR_cloudflare_main_api_token).toBeUndefined();
  expect(context.env.TF_VAR_cloudflare_dns_api_token).toBeUndefined();
});

test("payload credential values are exact-redaction values even when printed bare", () => {
  const runScopedToken = "opaque-run-scoped-token-1234567890";
  const gatewayRunKey = "run-key.2000000000.deadbeefcafebabefeedface";
  const context = commandContextFromRequest(
    requestWithCredentials({
      CLOUDFLARE_API_TOKEN: runScopedToken,
      CLOUDFLARE_API_KEY: gatewayRunKey,
    }),
    CLOUDFLARE_PROFILE,
  );

  expect(context.redactionValues).toContain(runScopedToken);
  expect(context.redactionValues).toContain(gatewayRunKey);
  const redacted = redactRunnerOutput(
    `provider echoed ${runScopedToken} and ${gatewayRunKey} as bare values`,
    context.redactionValues,
  );
  expect(redacted).not.toContain(runScopedToken);
  expect(redacted).not.toContain(gatewayRunKey);
  expect(redacted).toContain("[redacted]");
});

test("TF_VAR credentials are never sourced from ambient env", () => {
  const name = "TF_VAR_cloudflare_main_api_token";
  const prev = Bun.env[name];
  Bun.env[name] = "ambient-tf-var";
  try {
    // No credentials on the payload -> the ambient TF_VAR must NOT leak in.
    const context = commandContextFromRequest(REQUEST, CLOUDFLARE_PROFILE);
    expect(context.env[name]).toBeUndefined();
  } finally {
    restoreEnv(name, prev);
  }
});

test("a non-TF_VAR lowercase payload name is still rejected", () => {
  const context = commandContextFromRequest(
    requestWithCredentials({
      // Not TF_VAR-prefixed and not upper-snake -> ignored.
      tf_var_sneaky: "nope",
      TF_VARsneaky: "nope-too",
    }),
    CLOUDFLARE_PROFILE,
  );
  expect(context.env.tf_var_sneaky).toBeUndefined();
  expect(context.env.TF_VARsneaky).toBeUndefined();
});

test("ambient Capsule run identity env is admitted without a recipe binding", () => {
  const context = commandContextFromRequest(
    {
      ...REQUEST,
      credentials: {
        env: {
          TAKOSUMI_ENDPOINT: "https://app.takosumi.test/api",
          TAKOSUMI_TOKEN: "takrun_v1.payload.signature",
          TAKOSUMI_WORKSPACE_ID: "ws_1",
          TAKOSUMI_CAPSULE_ID: "cap_1",
        },
        // No manifest: ambient identity is not Credential Recipe material.
      },
    },
    CLOUDFLARE_PROFILE,
  );
  expect(context.env.TAKOSUMI_ENDPOINT).toEqual(
    "https://app.takosumi.test/api",
  );
  expect(context.env.TAKOSUMI_TOKEN).toEqual("takrun_v1.payload.signature");
  expect(context.env.TAKOSUMI_WORKSPACE_ID).toEqual("ws_1");
  expect(context.env.TAKOSUMI_CAPSULE_ID).toEqual("cap_1");
});

test("only the ambient run token is a redaction value; identity metadata is not", () => {
  const context = commandContextFromRequest(
    {
      ...REQUEST,
      credentials: {
        env: {
          TAKOSUMI_ENDPOINT: "https://app.takosumi.test/api",
          TAKOSUMI_TOKEN: "takrun_v1.secret.signature",
          TAKOSUMI_WORKSPACE_ID: "ws_1",
          TAKOSUMI_CAPSULE_ID: "cap_1",
        },
      },
    },
    CLOUDFLARE_PROFILE,
  );
  expect(context.redactionValues ?? []).toContain("takrun_v1.secret.signature");
  // Non-secret identity values (endpoint URL, workspace/capsule ids) legitimately
  // appear in plan output and must not be blanket-redacted.
  expect(context.redactionValues ?? []).not.toContain(
    "https://app.takosumi.test/api",
  );
  expect(context.redactionValues ?? []).not.toContain("ws_1");
});

test("a bare payload env without a manifest still rejects non-identity names", () => {
  expect(() =>
    commandContextFromRequest(
      {
        ...REQUEST,
        credentials: {
          env: {
            TAKOSUMI_TOKEN: "takrun_v1.a.b",
            CLOUDFLARE_API_TOKEN: "smuggled-without-manifest",
          },
        },
      },
      CLOUDFLARE_PROFILE,
    ),
  ).toThrow(/require an explicit run credential manifest/u);
});

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete Bun.env[name];
  else Bun.env[name] = prev;
}
