// takos-secret-scan: synthetic — isolated config and credential canaries only.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dir, "../..");
const credentialsUrl = pathToFileURL(join(repositoryRoot, "runner/lib/credentials.ts")).href;
const sourceUrl = pathToFileURL(join(repositoryRoot, "runner/lib/source_sync.ts")).href;
const decoder = new TextDecoder();

async function withConfigFixture(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "runner-git-config-"));
  try {
    await mkdir(join(root, "home/.config/git"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, "home/.gitconfig"), "[runner]\n ambient = HOME_CONFIG_CANARY\n", { mode: 0o600 });
    await writeFile(join(root, "home/.config/git/config"), "[runner]\n xdgambient = XDG_CONFIG_CANARY\n", { mode: 0o600 });
    await writeFile(join(root, "system.config"), "[runner]\n systemambient = SYSTEM_CONFIG_CANARY\n", { mode: 0o600 });
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function child(root: string, body: string): Record<string, unknown> {
  const program = `
    const {baseCommandEnv,buildPhaseEnv,assertCommandEnvHasNoProviderCredentials}=await import(${JSON.stringify(credentialsUrl)});
    const {prepareSourceGitContext,parseSourceCredentials}=await import(${JSON.stringify(sourceUrl)});
    const root=${JSON.stringify(root)};
    const {join}=await import("node:path");
    const decoder=new TextDecoder();
    const configValue=(env,key)=>{
      const result=Bun.spawnSync(["git","config","--get",key],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
      if(result.exitCode!==0&&result.exitCode!==1)throw new Error(decoder.decode(result.stderr));
      return result.exitCode===0?decoder.decode(result.stdout).trim():null;
    };
    ${body}
  `;
  const execution = Bun.spawnSync([process.execPath, "--no-env-file", "-e", program], {
    cwd: repositoryRoot,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: join(root, "home"),
      TMPDIR: root,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "bun-cache"),
      CI: "1",
      LANG: "C.UTF-8",
      TZ: "UTC",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(execution.exitCode, decoder.decode(execution.stderr)).toBe(0);
  const value: unknown = JSON.parse(decoder.decode(execution.stdout));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Git configuration fixture child must return an object");
  }
  return value as Record<string, unknown>;
}

test("Runner base and build Git commands ignore ambient HOME and XDG config", async () => {
  await withConfigFixture(async (root) => {
    const values = child(root, `
      console.log(JSON.stringify({environments:[baseCommandEnv(),buildPhaseEnv()].map(env=>({
        home:configValue(env,"runner.ambient"),xdg:configValue(env,"runner.xdgambient")
      }))}));
    `);
    expect(values).toEqual({ environments: [{ home: null, xdg: null }, { home: null, xdg: null }] });
  });
});

test("Source Git context keeps runtime config controls authoritative", async () => {
  await withConfigFixture(async (root) => {
    const result = child(root, `
      const {context}=await prepareSourceGitContext({url:"https://source.example.invalid/repo.git",ref:"main",path:"."},{
        env:{GIT_HTTPS_TOKEN:"SOURCE_TOKEN_CANARY",GIT_CONFIG_GLOBAL:join(root,"home/.gitconfig"),GIT_CONFIG_SYSTEM:join(root,"system.config"),GIT_CONFIG_NOSYSTEM:"0",GIT_TERMINAL_PROMPT:"1"},files:[]
      },join(root,"minted"));
      console.log(JSON.stringify({global:context.env.GIT_CONFIG_GLOBAL,system:context.env.GIT_CONFIG_SYSTEM,noSystem:context.env.GIT_CONFIG_NOSYSTEM,prompt:context.env.GIT_TERMINAL_PROMPT,tokenRetained:context.env.GIT_HTTPS_TOKEN==="SOURCE_TOKEN_CANARY",home:configValue(context.env,"runner.ambient"),systemValue:configValue(context.env,"runner.systemambient")}));
    `);
    expect(result).toEqual({ global: "/dev/null", system: "/dev/null", noSystem: "1", prompt: "0", tokenRetained: true, home: null, systemValue: null });
  });
});

test("HTTPS askpass retains minted token and phase scope with config isolation", async () => {
  await withConfigFixture(async (root) => {
    const script = JSON.stringify("#!/bin/sh\nprintf '%s' \"$GIT_HTTPS_TOKEN\"\n");
    const result = child(root, `
      const minted={env:{GIT_HTTPS_TOKEN:"SOURCE_TOKEN_CANARY"},files:[{path:"askpass.sh",mode:0o500,content:${script}}]};
      const {context}=await prepareSourceGitContext({url:"https://source.example.invalid/repo.git",ref:"main",path:"."},minted,join(root,"minted"));
      const pass=Bun.spawnSync([context.env.GIT_ASKPASS,"Password"],{env:context.env,stdout:"pipe",stderr:"pipe"});
      const build=buildPhaseEnv();assertCommandEnvHasNoProviderCredentials(build);
      console.log(JSON.stringify({delivered:pass.exitCode===0&&decoder.decode(pass.stdout)==="SOURCE_TOKEN_CANARY",buildHasNoToken:build.GIT_HTTPS_TOKEN===undefined,redactionRetained:context.redactionValues.includes("SOURCE_TOKEN_CANARY"),prompt:context.env.GIT_TERMINAL_PROMPT}));
    `);
    expect(result).toEqual({ delivered: true, buildHasNoToken: true, redactionRetained: true, prompt: "0" });
  });
});

test.each(["minted 'quoted directory", 'minted "double" directory', "minted\\slash directory"])("Source SSH preserves minted host and identity pins with config suppression: %s", async (directory) => {
  await withConfigFixture(async (root) => {
    const result = child(root, `
      const credentialDir=join(root,${JSON.stringify(directory)});
      const {context}=await prepareSourceGitContext({url:"ssh://git@source.example.invalid/repo.git",ref:"main",path:"."},{env:{},files:[
        {path:"known_hosts",mode:0o600,content:"source.example.invalid ssh-ed25519 SYNTHETIC_HOST"},
        {path:"key",mode:0o600,content:"SYNTHETIC_KEY_CANARY"}
      ]},credentialDir);
      const command=context.env.GIT_SSH_COMMAND;
      if(!command.startsWith("ssh -F /dev/null "))console.log(JSON.stringify({isolated:false}));
      else {
        const expanded=Bun.spawnSync(["sh","-c",command+" -G source.example.invalid"],{cwd:root,env:context.env,stdout:"pipe",stderr:"pipe"});
        if(expanded.exitCode!==0)throw new Error(decoder.decode(expanded.stderr));
        const rows=decoder.decode(expanded.stdout).split("\\n");
        const field=name=>rows.find(line=>line.startsWith(name+" "))?.slice(name.length+1);
        console.log(JSON.stringify({isolated:true,strict:["yes","true"].includes(field("stricthostkeychecking")),batch:field("batchmode")==="yes",identitiesOnly:field("identitiesonly")==="yes",proxyAbsent:!field("proxycommand")||field("proxycommand")==="none",hostsPinned:field("userknownhostsfile").includes(join(credentialDir,"known_hosts")),globalHostsDisabled:field("globalknownhostsfile")==="/dev/null",identityPinned:rows.some(line=>line==="identityfile "+join(credentialDir,"key"))}));
      }
    `);
    expect(result).toEqual({ isolated: true, strict: true, batch: true, identitiesOnly: true, proxyAbsent: true, hostsPinned: true, globalHostsDisabled: true, identityPinned: true });
  });
});

test.each(["key", "known_hosts", "none"])("Source SSH refuses incomplete minted credential set: %s", async (fileName) => {
  await withConfigFixture(async (root) => {
    const result = child(root, `
      const files=${JSON.stringify(fileName)}==="none"?[]:[{path:${JSON.stringify(fileName)},mode:0o600,content:"SYNTHETIC_INCOMPLETE_CANARY"}];
      let rejected=false;
      try {await prepareSourceGitContext({url:"ssh://git@source.example.invalid/repo.git",ref:"main",path:"."},{env:{},files},join(root,"minted"));}
      catch(error){rejected=error instanceof Error&&error.message.includes("requires");}
      console.log(JSON.stringify({rejected}));
    `);
    expect(result.rejected).toBe(true);
  });
});

test("Source SSH keeps percent tokens in minted key paths literal", async () => {
  await withConfigFixture(async (root) => {
    const result = child(root, `
      const credentialDir=join(root,"minted%h");
      const {context}=await prepareSourceGitContext({url:"ssh://git@source.example.invalid/repo.git",ref:"main",path:"."},{env:{},files:[
        {path:"known_hosts%h",mode:0o600,content:"source.example.invalid ssh-ed25519 SYNTHETIC_HOST"},
        {path:"key%h",mode:0o600,content:"SYNTHETIC_KEY_CANARY"}
      ]},credentialDir);
      const probe=Bun.spawnSync(["sh","-c",context.env.GIT_SSH_COMMAND+" -vvv -o 'ProxyCommand=cat /dev/null' -o IdentityFile=none -o ConnectTimeout=1 source.example.invalid"],{cwd:root,env:context.env,stdout:"pipe",stderr:"pipe"});
      const diagnostics=decoder.decode(probe.stderr);
      console.log(JSON.stringify({proxyClosed:probe.exitCode!==0,literalKeyObserved:diagnostics.includes("identity file "+join(credentialDir,"key%h")+" type"),literalHostsObserved:diagnostics.includes("-> '"+join(credentialDir,"known_hosts%h")+"'"),expandedHostKeyObserved:diagnostics.includes("identity file "+join(credentialDir,"keysource.example.invalid")+" type"),identityDiagnostics:diagnostics.split("\\n").filter(line=>/identity file|Identity file|UserKnownHostsFile|Warning/.test(line))}));
    `);
    const diagnostics = Array.isArray(result.identityDiagnostics) ? result.identityDiagnostics.map(String).join("\n") : "missing identity diagnostics";
    expect(result, diagnostics).toMatchObject({ proxyClosed: true, literalKeyObserved: true, literalHostsObserved: true, expandedHostKeyObserved: false });
  });
});

test.each(["minted ${UNSET_SSH_CREDENTIAL_PATH}", "minted\nline"])("Source SSH rejects credential path expansion syntax before writing: %s", async (directory) => {
  await withConfigFixture(async (root) => {
    const result = child(root, `
      const credentialDir=join(root,${JSON.stringify(directory)});
      let rejected=false;
      try {await prepareSourceGitContext({url:"ssh://git@source.example.invalid/repo.git",ref:"main",path:"."},{env:{},files:[{path:"known_hosts",mode:0o600,content:"SYNTHETIC_HOST"},{path:"key",mode:0o600,content:"SYNTHETIC_KEY_CANARY"}]},credentialDir);}
      catch(error){rejected=error instanceof Error&&error.message==="ssh credential path contains unsupported expansion syntax";}
      const {lstat}=await import("node:fs/promises");
      let created=true;try{await lstat(credentialDir);}catch{created=false;}
      console.log(JSON.stringify({rejected,created}));
    `);
    expect(result).toEqual({ rejected: true, created: false });
  });
});

test("External source credentials cannot declare Git policy overrides", async () => {
  await withConfigFixture(async (root) => {
    const result = child(root, `
      console.log(JSON.stringify(parseSourceCredentials({credentials:{env:{GIT_HTTPS_TOKEN:"SOURCE_TOKEN_CANARY",GIT_CONFIG_GLOBAL:"poison",GIT_CONFIG_SYSTEM:"poison",GIT_CONFIG_NOSYSTEM:"0",GIT_TERMINAL_PROMPT:"1"}}}).env));
    `);
    expect(result).toEqual({ GIT_HTTPS_TOKEN: "SOURCE_TOKEN_CANARY" });
  });
});
