import { expect, test } from "bun:test";
import { commandContextFromRequest } from "../../runner-image/entrypoint.ts";

// Runner profile that requires a cloudflare credential ref by env://.
const CLOUDFLARE_PROFILE = {
  id: "cloudflare-default",
  allowedProviders: ["cloudflare/cloudflare"],
  credentialRefs: [
    {
      provider: "cloudflare/cloudflare",
      ref: "env://CLOUDFLARE_API_TOKEN",
      required: true,
    },
  ],
};

const REQUEST = {
  planRun: {
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  },
};

test("payload credentials take precedence over Bun.env", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(
      { ...REQUEST, credentials: { CLOUDFLARE_API_TOKEN: "payload-token" } },
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toEqual("payload-token");
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("falls back to Bun.env when the payload omits the credential", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  Bun.env.CLOUDFLARE_API_TOKEN = "ambient-env-token";
  try {
    const context = commandContextFromRequest(REQUEST, CLOUDFLARE_PROFILE);
    expect(context.env.CLOUDFLARE_API_TOKEN).toEqual("ambient-env-token");
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

test("only env names a required provider allows are admitted from the payload", () => {
  const prev = Bun.env.CLOUDFLARE_API_TOKEN;
  delete Bun.env.CLOUDFLARE_API_TOKEN;
  try {
    const context = commandContextFromRequest(
      {
        ...REQUEST,
        credentials: {
          CLOUDFLARE_API_TOKEN: "payload-token",
          // Not a cloudflare env name; must be ignored.
          AWS_SECRET_ACCESS_KEY: "should-not-appear",
          // Invalid env-name shape; must be ignored.
          "lower-case": "nope",
        },
      },
      CLOUDFLARE_PROFILE,
    );
    expect(context.env.CLOUDFLARE_API_TOKEN).toEqual("payload-token");
    expect(context.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(context.env["lower-case"]).toBeUndefined();
  } finally {
    restoreEnv("CLOUDFLARE_API_TOKEN", prev);
  }
});

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete Bun.env[name];
  else Bun.env[name] = prev;
}
