# Mainfix: isolate browser-reactive resource tests

- Owner/repository: Takosumi only; branch
  `fix/takosumi-tanto-mainfix-lastgood-20261013`.
- Base: `eccdcd13329debb4c8548487f7df92544e013b05` (#420);
  failing Actions run: `38425957584`.
- Main integration: #422 merged while this fix was being verified, at
  `62095f11a111d83b2b99258ed759f0c516b5575a`. Its cache-busted import already
  avoids the original cached importer. This branch normally merges that main,
  replacing the overlapping test setup with process isolation to remove the
  shared Solid mock and adding failure-safe root/child cleanup. Uninstall code
  remains the main implementation. All final verification is restarted after
  integration; no force push or other-worktree edits are used.
- Final main integration: #423 and #426 are also normally merged; final base
  `f0d06cc1585b475e572016ef9d23988f460a08da`. The new replay-test delivery
  event, successful terminal assertion and cleanup from #426 are preserved
  exactly. The current owner gate has 20 phases, including its new export check.
- Scope: test runtime isolation, lease-test event synchronization and evidence.
  No product implementation,
  dependency, schema, deployment or release-entrypoint changes.
- Restrictions: no main push, force push, deployment, takos1 interaction or
  other-worktree edits. Staging publication belongs to stagingsync.
- Merge gate: current-head GitHub Actions green AND explicit approval from
  the quality/release QA owner, then ordinary `gh pr merge --squash`.

## Cause and deterministic proof

The sibling `resource-read_test.ts` imports `resource-read.ts` with Bun's
default `solid-js` server build. That build's `createMemo` evaluates once and
returns the initial value. The reactive test's later `mock.module("solid-js")`
does not re-evaluate the cached importer. Its browser resource updates, but
the cached server memo remains `undefined`.

The unmodified checkout passed the ordinary directory run on this filesystem
with both Bun 1.4.2 and CI's Bun 1.4.0. Argument order does not force Bun's file
evaluation order. A preload that imports the production module first makes the
reported failure deterministic:

```sh
# The temporary preload contains this import, using the absolute worktree path:
await import("/root/dev/takos/.worktrees/takosumi-tanto-mainfix-20261013/dashboard/src/lib/resource-read.ts");

# BUN140 is the independently installed Bun 1.4.0 executable; PRELOAD is that file.
env -u NODE_ENV "$BUN140" test --preload "$PRELOAD" \
  tests/dashboard/src/lib/resource-read-reactive_test.ts
```

Before the fix: **0 pass / 2 fail**, the exact original assertions at lines 41
and 65 receive `undefined`. After the fix: **2 pass / 0 fail**. The isolated
original file passed **2 pass / 0 fail**, confirming the warm-cache boundary.

## Fix

The parent deliberately imports `resource-read.ts` to warm its default cache.
Each of the two named tests starts the same Bun executable in a separate
process, selecting `--conditions=browser` before module evaluation. The explicit
fixture runs the original scenario against the real production helper and
Solid browser resource. No shared Solid module mock remains.

The fixture retains all original eight assertions; each parent requires a
successful child exit and one executed, passing test. The fixture filename is
not automatically discovered, so the default test sweep executes each scenario
once through its parent. Roots now dispose in `finally`, including assertion
failures. Independent Sol review found no blockers.
Each child also has a four-second SIGKILL timeout, shorter than the parent's
default five-second timeout, so a stalled child is stopped before the wrapper
times out during normal test execution.

## Additional full-gate finding

The first full gate passed the dashboard scenarios but failed an untouched core
test: `renewable ApplyRun discards an issued value when Capsule lease is lost
during mint`. That test alone reproduced **pass / fail / pass**. Its bounded
500-microtask/25-event-loop-turn poll sometimes ended before the renewal tick's
heartbeat and Capsule lease renewal reached the second-mint callback.

The held-mint test now waits on a Promise resolved directly by that callback. The existing
four lease-loss outcome assertions remain; reaching the callback is guaranteed
by awaiting its event instead of asserting a boolean after arbitrary polling.
The normal five-second test timeout still bounds the operation. Five focused
runs on each Bun 1.4.2 and Bun 1.4.0 all passed (ten runs total, each 1 pass /
0 fail, four outcome assertions). No production lease or credential code changed.

After #422 integration, another full gate failed in the same helper at
`renewable ApplyRun reissues before expiry and stops after terminal result`
(**5665 pass / 5 existing skips / 1 fail**). Every remaining poll in this file
is now replaced by direct refresh-delivery, mint-start, child-abort or mint-return
callback events. The refresh and expiry predicates remain explicit assertions
after their events, with the same fake-clock steps. #426 separately adds its
own typed replay outcome and terminal cleanup, which this branch preserves.
The final 44-test file passes on both Bun 1.4.2 and Bun 1.4.0, with **236
assertions / 0 fail** on each. Independent final review found no blockers.

The initial gate reported **5623 pass / 5 existing skips / 1 fail**. A retry was
stopped to apply the synchronization fix. The next gate was stopped to integrate
the newly merged #422 before publishing. Failed and interrupted attempts are
recorded in the PR; the final full gate is on the integrated #423/#426 main.

## Verification

Locked dependencies were installed from the existing root/dashboard Bun locks
and docs npm lock. Runtime: Bun 1.4.2, Node 26.1.0; compatibility runs: Bun 1.4.0.

| Command | Run | Result |
| --- | --- | --- |
| `bun test ./tests/dashboard/src` | 1 | 760 pass / 0 fail, 1.270s |
| `bun test ./tests/dashboard/src` | 2 | 760 pass / 0 fail, 1.242s |
| `bun test ./tests/dashboard/src` | 3 | 760 pass / 0 fail, 1.238s |
| `env -u NODE_ENV "$BUN140" test --randomize --seed=420 ./tests/dashboard/src` | 1 | 760 pass / 0 fail, 1.289s |
| `env -u NODE_ENV "$BUN140" test --randomize --seed=61013 ./tests/dashboard/src` | 2 | 760 pass / 0 fail, 1.257s |
| `env -u NODE_ENV "$BUN140" test --randomize --seed=38425957 ./tests/dashboard/src` | 3 | 760 pass / 0 fail, 1.246s |

These six dashboard runs are on the integrated test code at `d5b7f51a6`; all
exited 0. Earlier repeats were also green (742 before #422 and 743 after #422).
An earlier attempt to use the Actions run ID
`38425957584` as a seed was rejected before test execution because it exceeds
Bun's seed range; the valid seed `38425957` above was used instead.

Full gate, publication and external QA results are recorded in the PR body
and subsequent comments. External QA approval is separate from local review.
