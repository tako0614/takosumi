The Hosted metered native gate is separate from the portable product check:

```sh
bun scripts/check-hosted-metered-native.ts --image "$CACHED_RUNNER_IMAGE"
```

It requires Linux x64 host root, a local C compiler with static libc, Docker, and
an explicitly supplied immutable runtime already in the local cache. Realized
image/account configuration stays outside tracked source. The temporary host
parent remains mode 0700; only its inner mode 0755 fixture directory is mounted.
The gate never pulls or publishes an
image or calls a provider. Each invocation creates one uniquely named, bounded,
network-disabled Container, checks its exact host cgroup identity before allowing
the fixtures to run, and removes only that owned Container and temporary files.
The report explicitly labels the new source image UNBUILT. A source bind on an
older cached runtime does not qualify the new image or Cloudflare policy.

The ten real workloads exercise the production fixed-UID static launcher and
pinned cgroup counter, native and actual Bun post-exec isolation, threads, waited
and auto-reaped children, orphan/session escape, and timeout drain. The Bun
fixture calls the production hardening function before creating a provider; that
provider cannot read/write the trusted child proc FDs, read its memory, ptrace,
copy memory with process_vm_readv, or duplicate an FD with pidfd_getfd. SIGUSR1
and SIGUSR2 remain ignored after the attack and no TCP inspector appears. Same
UID providers can still signal-kill or stop the runner: the owning root protocol
must retain pending custody after that denial of service, never sign a close.

The separate `hosted-metered-guards.c` executable deliberately substitutes file
and syscall fixtures to test missing/reset/replaced/malformed counter and
membership failure branches. Its report is explicitly a syscall fault unit
check, never real kernel-counter qualification. No production measurement has a
fixture source or a wall-time/rusage fallback. A rejected sample leaves all
output arguments untouched and the native source permanently unavailable.

## Local encrypted state and output reconstruction

```sh
bun run test:encrypted-state-native
```

This separate node-postgres subgroup needs installed Bun, OpenTofu, tar/zstd and
locked dependencies. Missing tools fail the command. It needs neither Docker,
host root nor a provider/account; run it in a network-isolated OS sandbox with
read-only source/tools, a private HOME/tmp and bounded scratch/resources. It is
excluded from the portable test command and is outside `test:accounts` discovery.
The owning entry always starts the outer private-root wrapper, regardless of an
ambient internal child flag. On failure, its retained 0700 root contains bounded
`child.stdout.log` / `child.stderr.log` files created exclusively with mode 0600;
a diagnostic write failure preserves the original child failure.

The test discovers the real source declaration, changes a nonsecret input through
the normal configuration API, and verifies a native output-only Plan/Apply change.
It binds state/raw-output references and encrypted bytes, saves a data-bearing
PGlite snapshot, then uses new Core/SQL/file-store/crypto objects and a fresh
handler to read the same Run and both generations without another Apply. The
same random test key is deliberately reinjected into a distinct crypto instance;
no key is written or logged. A stored synthetic management account-session drives
initial installation, canonical app ownership, configuration and explicit Apply.
The current owner/member roles survive SQL reconstruction; removed app members
and revoked sessions are refused even with known app/Run IDs, without changing
state files, the effective config or Run IDs. The Memory Accounts store remains
live while Core is reconstructed; initial accounts/sessions and Git transport
remain fixtures. App-data OAuth Link/Binding is a separate authority. With no
public output allowlist declared, this fixture checks nonempty state/raw outputs
without publishing them. This proves same-process fresh objects, not OS restart,
crash durability, real PostgreSQL, genuine identity or managed-resource effects.
