import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesPath = new URL('./styles.css', import.meta.url);
const bundledDisplayFontPath = new URL('../public/fonts/doto-700.ttf', import.meta.url);
const styles = readFileSync(stylesPath, 'utf8');

describe('Nothing-style typography contract', () => {
  it('keeps the display font bundled locally', () => {
    expect(existsSync(bundledDisplayFontPath)).toBe(true);
    expect(styles).toMatch(
      /@font-face\s*{[^}]*font-family:\s*"Doto";[^}]*src:\s*url\("\/fonts\/doto-700\.ttf"\)/s,
    );
  });

  it('does not fetch fonts from remote providers', () => {
    expect(styles).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/i);
    expect(styles).not.toMatch(/@import\s+url\((["'])https?:\/\//i);
  });

  it('keeps the Nothing display stack on the brand mark', () => {
    expect(styles).toMatch(/--font-display:\s*"Doto",\s*"Space Mono"/s);
    expect(styles).toMatch(/\.brand-mark\s*{[^}]*font-family:\s*var\(--font-display\);/s);
  });
});
