import { afterEach, describe, expect, test } from "bun:test";
import { interfaceLabel, interfacePermissionList } from "../../../../dashboard/src/lib/interface-labels.ts";
import {
  decideInterfaceLink,
  getInterfaceLinkCandidates,
  revokeInterfaceLink,
  setInterfaceLink,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("app Interface link control client", () => {
  test("reads exact consumer and requirement candidates with the observed generation", async () => {
    const body = { candidates: [{ interfaceId: "if_a", providerCapsuleId: "cap_provider", providerCapsuleName: "Files", interfaceName: "files" }], generation: 7 };
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return Response.json(body);
    }) as typeof fetch;
    expect(await getInterfaceLinkCandidates("cap a/b", "files/read")).toEqual(body);
    expect(calls).toEqual(["/api/v1/capsules/cap%20a%2Fb/interface-links/files%2Fread/candidates"]);
  });

  test("selection and revocation send exact generations and no caller permissions", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return Response.json({ link: { id: "il_a" } });
    }) as typeof fetch;
    await setInterfaceLink("cap_consumer", "files", { interfaceId: "if_b", expectedGeneration: 7 });
    await revokeInterfaceLink("cap_consumer", "files", 8);
    expect(calls).toEqual([
      { url: "/api/v1/capsules/cap_consumer/interface-links/files", method: "PUT", body: { interfaceId: "if_b", expectedGeneration: 7 } },
      { url: "/api/v1/capsules/cap_consumer/interface-links/files", method: "DELETE", body: { expectedGeneration: 8 } },
    ]);
  });

  test("provider approval and decline address the provider app by link id with the read generation only", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
      return Response.json({ link: { id: "ifl a" } });
    }) as typeof fetch;
    await decideInterfaceLink("cap provider", "ifl a/b", "approve", 3);
    await decideInterfaceLink("cap_provider", "ifl_c", "decline", 5);
    expect(calls).toEqual([
      { url: "/api/v1/capsules/cap%20provider/interface-links/ifl%20a%2Fb/approve", method: "POST", body: { expectedGeneration: 3 } },
      { url: "/api/v1/capsules/cap_provider/interface-links/ifl_c/decline", method: "POST", body: { expectedGeneration: 5 } },
    ]);
  });

  test("permissions are shown as readable words, never raw permission strings", () => {
    expect(interfaceLabel("mcp.read")).toBe("Mcp · Read");
    expect(interfacePermissionList(["files.read", "files:write_all"])).toBe("Files · Read, Files · Write · All");
  });

  test("a generation conflict is returned without replaying the mutation", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ error: { code: "conflict", message: "Link changed." } }, { status: 409 });
    }) as typeof fetch;
    await expect(setInterfaceLink("cap_consumer", "files", { interfaceId: "if_b", expectedGeneration: 7 })).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(calls).toBe(1);
  });
});
