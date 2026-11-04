import barlow500 from '@fontsource/barlow/files/barlow-latin-500-normal.woff2?inline';
import barlow600 from '@fontsource/barlow/files/barlow-latin-600-normal.woff2?inline';
import barlow700 from '@fontsource/barlow/files/barlow-latin-700-normal.woff2?inline';
import condensed600 from '@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-600-normal.woff2?inline';
import condensed700 from '@fontsource/barlow-semi-condensed/files/barlow-semi-condensed-latin-700-normal.woff2?inline';

/** Family names the panel stylesheet asks for; prefixed so they never clash with the page's. */
export const PANEL_FONT = 'Nesty Barlow';
export const PANEL_FONT_NUM = 'Nesty Barlow SC';

const FACES: [family: string, weight: string, dataUrl: string][] = [
  [PANEL_FONT, '500', barlow500],
  [PANEL_FONT, '600', barlow600],
  [PANEL_FONT, '700', barlow700],
  [PANEL_FONT_NUM, '600', condensed600],
  [PANEL_FONT_NUM, '700', condensed700],
];

/**
 * Registers the panel's fonts with the page's font set. A font declared inside a shadow
 * root is ignored, so they go on the document. They are built from bytes in the bundle,
 * not a URL: nothing is fetched and the page's font-src CSP has nothing to block. When it
 * fails the stylesheet falls back to Bahnschrift / system UI.
 */
export function loadPanelFonts(): void {
  try {
    for (const [family, weight, dataUrl] of FACES) {
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      document.fonts.add(new FontFace(family, bytes, { weight, display: 'swap' }));
    }
  } catch {
    /* fall back to system fonts */
  }
}
