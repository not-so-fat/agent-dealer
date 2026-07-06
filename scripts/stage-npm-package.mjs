#!/usr/bin/env node
/**
 * Stage a self-contained agent-dealer npm package (CLI + server + shared).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const stageRoot = path.join(root, ".temporal/npm-stage/agent-dealer");

function cp(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

console.log("[stage-npm] build:release");
execSync("node scripts/prepare-release.mjs", { cwd: root, stdio: "inherit" });

const cliPkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages/cli/package.json"), "utf8"),
);

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });

const serverPkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages/server/package.json"), "utf8"),
);
const sharedPkg = JSON.parse(
  fs.readFileSync(path.join(root, "packages/shared/package.json"), "utf8"),
);

const stagedPkg = { ...cliPkg };
delete stagedPkg.bundledDependencies;
stagedPkg.dependencies = {
  ...sharedPkg.dependencies,
  ...serverPkg.dependencies,
};
delete stagedPkg.dependencies["@agent-dealer/shared"];
delete stagedPkg.dependencies["@agent-dealer/server"];
stagedPkg.files = ["dist", "templates", "bundle"];
stagedPkg.scripts = { ...stagedPkg.scripts, postinstall: "node ./dist/postinstall.js" };

fs.writeFileSync(path.join(stageRoot, "package.json"), `${JSON.stringify(stagedPkg, null, 2)}\n`);

cp(path.join(root, "packages/cli/dist"), path.join(stageRoot, "dist"));
cp(path.join(root, "packages/cli/templates"), path.join(stageRoot, "templates"));

const bundleServer = path.join(stageRoot, "bundle/server");
cp(path.join(root, "packages/server/dist"), path.join(bundleServer, "dist"));
cp(path.join(root, "packages/server/static-ui"), path.join(bundleServer, "static-ui"));
fs.writeFileSync(
  path.join(bundleServer, "package.json"),
  fs.readFileSync(path.join(root, "packages/server/package.json"), "utf8"),
);

const bundleShared = path.join(stageRoot, "bundle/shared");
cp(path.join(root, "packages/shared/dist"), path.join(bundleShared, "dist"));
fs.writeFileSync(
  path.join(bundleShared, "package.json"),
  fs.readFileSync(path.join(root, "packages/shared/package.json"), "utf8"),
);

console.log(`[stage-npm] staged at ${stageRoot}`);
