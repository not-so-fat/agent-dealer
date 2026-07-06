import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const bundleRoot = path.join(root, "bundle");
const targetRoot = path.join(root, "node_modules", "@agent-dealer");

if (!fs.existsSync(bundleRoot)) {
  process.exit(0);
}

for (const name of ["server", "shared"]) {
  const src = path.join(bundleRoot, name);
  const dest = path.join(targetRoot, name);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}
