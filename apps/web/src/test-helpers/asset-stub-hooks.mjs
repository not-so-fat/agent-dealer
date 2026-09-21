// NOT-227: stub static asset imports (*.png, *.svg, *.ico, *.css) so shell
// tests can render under node:test, where neither Vite nor tsx resolves asset
// modules. Registered from the test file via node:module register() before it
// dynamically imports the component tree.
const STUBBED = new Set([".png", ".svg", ".ico", ".css"]);

function extensionOf(specifier) {
  const path = String(specifier).split("?")[0];
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot).toLowerCase();
}

export async function resolve(specifier, context, next) {
  if (STUBBED.has(extensionOf(specifier))) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (STUBBED.has(extensionOf(url))) {
    return {
      format: "module",
      source: `export default ${JSON.stringify(url)};`,
      shortCircuit: true,
    };
  }
  return next(url, context);
}
