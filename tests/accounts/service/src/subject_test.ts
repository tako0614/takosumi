import { expect, test } from "bun:test";
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "../../../helpers/assert.ts";
import { derivePairwiseSubject, deriveTakosumiSubject } from "../../../../accounts/service/src/subject.ts";

test("deriveTakosumiSubject is stable for the same upstream identity", async () => {
  const first = await deriveTakosumiSubject({
    secret: "dev-secret",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
  });
  const second = await deriveTakosumiSubject({
    secret: "dev-secret",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
  });

  expect(first).toEqual(second);
  expect(first.startsWith("tsub_")).toEqual(true);
});

test("deriveTakosumiSubject separates upstream issuers", async () => {
  const github = await deriveTakosumiSubject({
    secret: "dev-secret",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
  });
  const secondIssuer = await deriveTakosumiSubject({
    secret: "dev-secret",
    upstreamIssuer: "https://idp-b.example.test",
    upstreamSubject: "12345",
  });

  expect(github).not.toEqual(secondIssuer);
});

test("derivePairwiseSubject separates OIDC clients", async () => {
  const subject = await deriveTakosumiSubject({
    secret: "dev-secret",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
  });
  const first = await derivePairwiseSubject({
    secret: "pairwise-secret",
    takosumiSubject: subject,
    clientId: "takos-chat",
  });
  const second = await derivePairwiseSubject({
    secret: "pairwise-secret",
    takosumiSubject: subject,
    clientId: "third-party-app",
  });

  expect(first).not.toEqual(second);
  expect(first.startsWith("tsub_")).toEqual(true);
});

test("deriveTakosumiSubject rejects empty subject inputs", async () => {
  await assertRejects(
    () =>
      deriveTakosumiSubject({
        secret: "dev-secret",
        upstreamIssuer: "https://github.com",
        upstreamSubject: " ",
      }),
    TypeError,
    "must not be empty",
  );
});
