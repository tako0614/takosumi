// takos-secret-scan: synthetic — dummy source credential and isolated Git shim.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourceModule = pathToFileURL(resolve(import.meta.dir, "../../runner/lib/source_sync.ts")).href;
const commit = "1".repeat(40);

interface GitObservation {
  readonly args: string[];
  readonly config: Record<string, string>;
  readonly tokenPresent: boolean;
}

async function scenario(input: {
  action: "source_sync" | "stable_semver_tag";
  addresses?: readonly string[];
  url?: string;
  version?: string;
  exactCommit?: boolean;
  curlRuntime?: unknown;
}): Promise<{ error: string | null; dnsCalls: number; observations: GitObservation[] }> {
  const root = await mkdtemp(join(tmpdir(), "source-git-transport-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin);
    const probe = join(root, "git-probe.ts");
    const observations = join(root, "observations.jsonl");
    await writeFile(probe, `
      import {appendFileSync} from "node:fs";
      const args=process.argv.slice(2),config={};
      for(let i=0;i<Math.min(Number(process.env.GIT_CONFIG_COUNT??"0"),20);i++){
        config[process.env["GIT_CONFIG_KEY_"+i]]=process.env["GIT_CONFIG_VALUE_"+i];
      }
      appendFileSync(${JSON.stringify(observations)},JSON.stringify({args,config,tokenPresent:process.env.GIT_HTTPS_TOKEN==="DUMMY_SOURCE_TOKEN"})+"\\n");
      if(args[0]==="--version")console.log(${JSON.stringify(`git version ${input.version ?? "2.43.0"}`)});
      else if(args[0]==="ls-remote")console.log(${JSON.stringify(`${commit}\t${input.action === "stable_semver_tag" ? "refs/tags/v1.0.0" : "refs/heads/main"}`)});
      else if(args[0]==="fetch")process.exit(9);
    `);
    await writeFile(join(bin, "git"), `#!/bin/sh\nexec '${process.execPath}' '${probe}' "$@"\n`);
    await chmod(join(bin, "git"), 0o700);
    const program = `
      import {mock} from "bun:test";
      import {readFile} from "node:fs/promises";
      let dnsCalls=0;
      const policyUrl=${JSON.stringify(sourceModule.replace("source_sync.ts", "policy.ts"))};
      const policy=await import(policyUrl),validate=policy.assertResolvedHostNotBlocked;
      const resolver=async()=>{dnsCalls++;return ${JSON.stringify(input.addresses ?? ["203.0.113.10", "2001:db8::10"])};};
      // Keep the actual public-address validator; replace only its resolver.
      mock.module(policyUrl,()=>({...policy,assertResolvedHostNotBlocked:(host,label,selected)=>validate(host,label,selected??resolver)}));
      const runtimeUrl=${JSON.stringify(sourceModule.replace("source_sync.ts", "git_curl_runtime.ts"))};
      mock.module(runtimeUrl,()=>({readGitCurlRuntime:async()=>(${JSON.stringify(input.curlRuntime === undefined ? {versionNumber: 0x073b00, ipv6: true} : input.curlRuntime)})}));
      const {runSourceSync,runStableSemverTagResolution}=await import(${JSON.stringify(sourceModule)});
      let error=null;
      try {
        const url=${JSON.stringify(input.url ?? "https://git.example.test:8443/repo.git")};
        if(${JSON.stringify(input.action)}==="stable_semver_tag")await runStableSemverTagResolution("pin_tags",{url});
        else await runSourceSync("pin_source",{action:"source_sync",archiveRef:"apps/fixture/source.tar.zst",source:{url,ref:${JSON.stringify(input.exactCommit ? commit : "main")},path:"."},credentials:{env:{GIT_HTTPS_TOKEN:"DUMMY_SOURCE_TOKEN"}}});
      } catch(cause){error=cause instanceof Error?cause.message:String(cause);}
      const lines=await readFile(${JSON.stringify(observations)},"utf8").catch(()=>"");
      console.log(JSON.stringify({error,dnsCalls,observations:lines.trim()?lines.trim().split("\\n").map(line=>JSON.parse(line)):[]}));
    `;
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), TMPDIR: root,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "cache"),
        TAKOSUMI_OPENTOFU_RUN_ROOT: join(root, "runs"),
        LANG: "C.UTF-8", TZ: "UTC", CI: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    return JSON.parse(new TextDecoder().decode(result.stdout));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const action of ["source_sync", "stable_semver_tag"] as const) {
  test(`${action}: every HTTPS Git operation uses the validated addresses and rejects redirects`, async () => {
    const result = await scenario({ action });
    const remote = result.observations.filter(x => x.args[0] === "ls-remote" || x.args[0] === "fetch");
    expect(result.dnsCalls).toBe(1);
    expect(remote.length).toBe(action === "source_sync" ? 3 : 1);
    for (const call of remote) {
      expect(call.config["http.followRedirects"]).toBe("false");
      expect(call.config["http.curloptResolve"]).toBe("git.example.test:8443:203.0.113.10,[2001:db8::10]");
      expect(call.tokenPresent).toBe(action === "source_sync");
    }
    expect(result.error).toBe(action === "source_sync" ? "git fetch failed with 9: " : null);
  });

  test(`${action}: unsupported Git refuses before any remote operation`, async () => {
    const result = await scenario({ action, version: "2.36.9" });
    expect(result.error).toContain("Git 2.37");
    expect(result.observations.some(x => x.args[0] === "ls-remote" || x.args[0] === "fetch")).toBe(false);
  });

  test.each([
    { versionNumber: 0x073a00, ipv6: true },
    { versionNumber: 0x073b00, ipv6: false },
    { versionNumber: "0x073b00", ipv6: true },
    null,
  ])(`${action}: unsupported or unknown Git-linked libcurl refuses before remote execution: %j`, async curlRuntime => {
    const result = await scenario({ action, curlRuntime });
    expect(result.error).toContain("Git-linked libcurl");
    expect(result.observations.some(x => x.args[0] === "ls-remote" || x.args[0] === "fetch")).toBe(false);
  });

  test(`${action}: a blocked DNS answer refuses before Git or credential effects`, async () => {
    const result = await scenario({ action, addresses: ["203.0.113.10", "10.0.0.1"] });
    expect(result.error).toContain("blocked address");
    expect(result.observations).toEqual([]);
  });

  test(`${action}: a non-IP resolver answer cannot become Git configuration`, async () => {
    const result = await scenario({ action, addresses: ["203.0.113.10", "not-an-ip"] });
    expect(result.error).toContain("invalid IP address");
    expect(result.observations).toEqual([]);
  });
}

test("exact source commit keeps the address pin through both fetch attempts", async () => {
  const result = await scenario({ action: "source_sync", exactCommit: true });
  expect(result.observations.some(x => x.args[0] === "ls-remote")).toBe(false);
  const fetches = result.observations.filter(x => x.args[0] === "fetch");
  expect(fetches).toHaveLength(2);
  for (const call of fetches) {
    expect(call.config["http.curloptResolve"]).toBe("git.example.test:8443:203.0.113.10,[2001:db8::10]");
    expect(call.config["http.followRedirects"]).toBe("false");
  }
});

test("literal HTTPS hosts refuse redirects without a second DNS lookup", async () => {
  for (const url of ["https://1.1.1.1/repo.git", "https://[2606:4700::1111]/repo.git"]) {
    const result = await scenario({ action: "stable_semver_tag", url });
    expect(result.dnsCalls).toBe(0);
    expect(result.error).toBeNull();
    const remote = result.observations.find(x => x.args[0] === "ls-remote")!;
    expect(remote.config["http.followRedirects"]).toBe("false");
    expect(remote.config["http.curloptResolve"]).toBeUndefined();
  }
});

test("IPv4-only DNS pins do not require an unavailable IPv6 feature", async () => {
  const result = await scenario({ action: "stable_semver_tag", addresses: ["203.0.113.10"], curlRuntime: { versionNumber: 0x073b00, ipv6: false } });
  expect(result.error).toBeNull();
  expect(result.observations.find(x => x.args[0] === "ls-remote")?.config["http.curloptResolve"]).toBe("git.example.test:8443:203.0.113.10");
});
