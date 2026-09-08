#!/usr/bin/env -S nub --no-env-file

// --no-env-file is load-bearing: nub auto-discovers `.env*` from the cwd, so
// without it, running this CLI inside any project that keeps sandbox
// BRALE_* credentials in its `.env` silently swaps them in — even past an
// explicit `env -u` — and every prod command fails auth (or worse, targets
// the wrong environment). Credentials enter only through the process
// environment or an op:// reference, deliberately.
import { cli } from './index.js'

cli.serve()
