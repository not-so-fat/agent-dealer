import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MACOS_MONACO_PATH = "/System/Library/Fonts/Monaco.ttf";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(root, "public", "fonts", "Monaco.ttf");

fs.mkdirSync(path.dirname(dest), { recursive: true });

if (fs.existsSync(dest)) {
  console.log("[monaco-font] already present:", dest);
  process.exit(0);
}

if (!fs.existsSync(MACOS_MONACO_PATH)) {
  console.warn(
    "[monaco-font] System Monaco not found (non-macOS?). Editors will fall back to Menlo."
  );
  process.exit(0);
}

fs.copyFileSync(MACOS_MONACO_PATH, dest);
console.log("[monaco-font] copied system Monaco → public/fonts/Monaco.ttf");
