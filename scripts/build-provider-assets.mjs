#!/usr/bin/env bun
// Historical compatibility entrypoint. The Takosumi provider is discontinued;
// this verifies custody and intentionally emits no provider assets.
import { verifyProviderCustody } from "./provider-custody.mjs";

await verifyProviderCustody();
