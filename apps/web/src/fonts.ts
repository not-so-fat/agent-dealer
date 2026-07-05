/** Load Monaco webfont before paint (agent-deck relies on system Monaco; we serve the .ttf for Chrome). */
export function ensureMonacoFontLoaded(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  return document.fonts.load('13px "Monaco"').then(() => undefined).catch(() => undefined);
}
