#!/usr/bin/env node

import { installNodeHardening } from "./node-hardening.js";
import { runCli } from "./index.js";

// NOT-370: install before any fetch/probe path can run.
installNodeHardening();

runCli(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
