import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** macOS system path — not redistributed; served/copied locally at build/dev time. */
export const MACOS_MONACO_PATH = "/System/Library/Fonts/Monaco.ttf";
export const PUBLIC_FONT_URL = "/fonts/Monaco.ttf";

function resolvePublicFontPath(root: string): string {
  return path.join(root, "public", "fonts", "Monaco.ttf");
}

function ensureMonacoFontFile(root: string): boolean {
  const dest = resolvePublicFontPath(root);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) return true;
  if (!fs.existsSync(MACOS_MONACO_PATH)) return false;
  fs.copyFileSync(MACOS_MONACO_PATH, dest);
  return true;
}

/** Serve Monaco.ttf from disk so browsers load the real face (local() is unreliable in Chrome). */
export function monacoFontPlugin(): Plugin {
  let root = process.cwd();

  return {
    name: "monaco-font",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(PUBLIC_FONT_URL, (req, res, next) => {
        const src = fs.existsSync(resolvePublicFontPath(root))
          ? resolvePublicFontPath(root)
          : fs.existsSync(MACOS_MONACO_PATH)
            ? MACOS_MONACO_PATH
            : null;
        if (!src) return next();
        res.setHeader("Content-Type", "font/ttf");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        fs.createReadStream(src).pipe(res);
      });
    },
    buildStart() {
      ensureMonacoFontFile(root);
    },
  };
}

export function monacoFontAvailable(root: string): boolean {
  return fs.existsSync(resolvePublicFontPath(root)) || fs.existsSync(MACOS_MONACO_PATH);
}
