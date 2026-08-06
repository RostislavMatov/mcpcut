#!/usr/bin/env node
// Prints the child's entire environment as a single JSON line and exits.
//
// Used by spawn tests to assert exactly which variables crossed the
// spawn boundary (controlled-env path of the M3 registry). Plain
// executable .mjs so no TS loader is required to spawn it.

process.stdout.write(`${JSON.stringify(process.env)}\n`)
