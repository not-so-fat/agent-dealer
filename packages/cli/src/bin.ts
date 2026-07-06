#!/usr/bin/env node

import { runCli } from "./index.js";

runCli(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
