import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline';

/**
 * The family the panel stylesheet asks for, for text and numbers alike (Inter, as on
 * nesty.trade); prefixed so it never clashes with the page's.
 */
export const PANEL_FONT = 'Nesty Inter';

/**
 * Registers the panel's font with the page's font set. A font declared inside a shadow
 * root is ignored, so it goes on the document. It is built from bytes in the bundle, not
 * a URL: nothing is fetched and the page's font-src CSP has nothing to block. One variable
 * file holds every weight. When it fails the stylesheet falls back to system UI.
 */
export function loadPanelFonts(): void {
  try {
    const b64 = inter.slice(inter.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    document.fonts.add(new FontFace(PANEL_FONT, bytes, { weight: '100 900', display: 'swap' }));
  } catch {
    /* fall back to system fonts */
  }
}
