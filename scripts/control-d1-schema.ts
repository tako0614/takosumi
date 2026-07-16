#!/usr/bin/env bun
import { runControlD1SchemaCli } from "../deploy/platform/control_d1_schema_cli.ts";

process.exitCode = await runControlD1SchemaCli(process.argv.slice(2));
