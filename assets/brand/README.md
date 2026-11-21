# Aegis brand assets

## Included
- `logo.svg`: primary gradient mark on transparent background.
- `logo-mono.svg`, `logo-white.svg`: single-colour vector marks.
- `logo.png`, `logo-mono.png`, `logo-white.png`: 1024px transparent PNG exports.
- `app-icon.svg`, `app-icon-1024.png`: dark rounded-square application icon with transparent corners.
- `logo-small.svg`, `logo-small-{16,32,64,128}.png`: simplified optical small-size variant.
- `tray.svg`, `tray-white.svg`: monochrome vector menu/tray glyphs.
- `tray-{22,44}.png`, `tray-white-{22,44}.png`: 1x/2x tray PNGs.
- `wordmark.svg`: horizontal mark plus Aegis wordmark.
- `preview-sheet.png`: visual overview.

## Palette
- Gradient: `#3BE0B6` → `#2F69FF`
- Ink: `#0B1116`
- White: `#FFFFFF`

## Integration notes
- Use `tray.svg` as the source for a platform template image where supported; template images should be single-colour with transparency.
- `tray-white.svg` is for integrations that require an explicitly white glyph.
- The 16px/32px small-size assets are optical simplifications; validate them in the actual target OS tray.
- `wordmark.svg` uses a system-font stack for “Aegis”. Convert the text to outlines in a vector editor if font-independent output is required.
- The app icon has transparent rounded corners. Some platform packaging pipelines expect a full-bleed square PNG and apply their own corner mask; adapt the tile export to that pipeline rather than double-rounding it.

## Licensing
Original branding artwork. Apply the project's chosen MIT OR Apache-2.0 terms if desired.
