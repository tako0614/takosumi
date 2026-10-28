# CI quality gate

`bun run check` is the complete local gate. It runs every portable gate phase
serially, including format and static checks, the portable tests, dashboard
build and browser E2E, docs browser E2E, and the remaining build checks. A local
full check is useful for reproducing CI, but CI divides those same phases among
jobs to shorten feedback time.

## CI jobs

The static job runs every `bun run check` phase
except `tests`, `dashboard-browser`, and `docs-browser`. The portable unit-test
phase runs as six initial shards. The dashboard browser E2E and docs browser
E2E each run in their own job. Tests and docs browser checks start alongside
static checks; dashboard browser checks download the static job's dashboard
build after that job succeeds. The final `check and test` result requires every static,
test-shard, dashboard-browser, and docs-browser job to succeed; a partial set of
green jobs is not a passing gate. The shard count is an initial CI setting and
may be adjusted as the suite changes.

Each test shard receives `TAKOSUMI_TEST_SHARD=i/N` (initially `1/6` through
`6/6`). Sharding partitions the test-file set across runs. The committed
`tests/.bun-test-timings.json` helps balance those partitions by recent file
durations; timing data is a scheduling hint, not the definition of which tests
belong to the suite. New files or files without timing data remain included by
Bun's shard partitioning.

Shard test files run sequentially within each shard. Do not add Bun's
`--parallel` to a shard run: worker concurrency can make timing-sensitive tests
flaky. The two isolated `workerd` tests run only in shard 1, so CI executes that
runtime setup once. A full unsharded test run also executes them once.

To select phases for focused work, use `bun run check --only tests` or
`bun run check --except tests,dashboard-browser,docs-browser`. Unknown names
and empty selections fail before running any command. Use `bun run check`
without options for the complete local gate.

Refresh the timing file by running the complete unsharded test suite:

```bash
env -u TAKOSUMI_TEST_SHARD bun scripts/run-portable-tests.ts --update-timings
```

Review and commit timing updates with the test changes that informed them. Do
not hand-edit the timing file to omit tests or encode test selection.

For Bun's documented shard partitioning and duration-based timing behavior, see
the [Bun test runner documentation](https://bun.com/docs/test).
