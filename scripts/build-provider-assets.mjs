#!/usr/bin/env bun
// Compatibility entrypoint. Provider assets are immutable release inputs now;
// this normal/check path verifies manifests and never builds provider binaries.
import { runProviderReleaseCli } from "./provider-release.mjs";

await runProviderReleaseCli(["verify-source"]);
