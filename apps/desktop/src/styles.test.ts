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

  it('keeps the light paper canvas and restrained chrome', () => {
    expect(styles).toMatch(/color-scheme:\s*light;/);
    expect(styles).toMatch(/--page:\s*#f5f1e8;/);
    expect(styles).toMatch(/--surface:\s*#fffdf8;/);
    expect(styles).toMatch(/--accent:\s*#d71921;/);
    expect(styles).toMatch(/body\s*{[\s\S]*overflow-x:\s*hidden;[\s\S]*overflow-y:\s*auto;/s);
    expect(styles).toMatch(/\.shell\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*17rem\)\s+minmax\(0,\s*1fr\);/s);
    expect(styles).toMatch(/\.session-board-layout\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1\.55fr\)\s+minmax\(18rem,\s*22rem\);/s);
    expect(styles).toMatch(/\.session-ledger-row\s*{[^}]*border-top:\s*1px solid var\(--border\);/s);
    expect(styles).toMatch(/\.context-rail\s*{[^}]*background:\s*var\(--surface\);/s);
    expect(styles).not.toMatch(/\.sidebar\s*{[^}]*overflow:\s*auto;/s);
    expect(styles).not.toMatch(/\.content\s*{[^}]*overflow:\s*auto;/s);
    expect(styles).not.toMatch(/backdrop-filter\s*:/i);
    expect(styles).not.toMatch(/box-shadow\s*:/i);
    expect(styles).not.toMatch(/linear-gradient|radial-gradient/i);
  });

  it('keeps the Nothing display and mono utility stacks on rendered surfaces', () => {
    expect(styles).toMatch(/--font-display:\s*"Doto",\s*"Space Mono"/s);
    expect(styles).toMatch(/\.brand-mark\s*{[^}]*font-family:\s*var\(--font-display\);/s);
    expect(styles).toMatch(/\.brand-mark\s*{[^}]*font-size:\s*clamp\(1\.9rem,\s*2\.8vw,\s*2\.75rem\);/s);
    expect(styles).toMatch(/button\s*{[\s\S]*font-family:\s*var\(--font-sans\);[\s\S]*text-transform:\s*none;/s);
    expect(styles).toMatch(/\.board-topline h2\s*{[^}]*font-family:\s*var\(--font-sans\);[^}]*font-size:\s*1\.1rem;/s);
    expect(styles).toMatch(/\.context-rail-label\s*{[\s\S]*font-family:\s*var\(--font-mono\);/s);
    expect(styles).toMatch(/\.session-ledger-status\s*{[\s\S]*font-family:\s*var\(--font-mono\);/s);
    expect(styles).toMatch(/\.settings-button\s*{[\s\S]*font-family:\s*var\(--font-mono\);[\s\S]*text-transform:\s*uppercase;/s);
    expect(styles).toMatch(/\.add-root-button\s*{[\s\S]*font-family:\s*var\(--font-mono\);[\s\S]*text-transform:\s*uppercase;/s);
  });

  it('compresses supporting chrome and activity copy during the final polish pass', () => {
    expect(styles).toMatch(/\.sidebar-top\s*{[^}]*align-items:\s*flex-start;/s);
    expect(styles).toMatch(/\.sidebar-actions\s*{[^}]*padding-top:\s*0\.25rem;/s);
    expect(styles).toMatch(/\.context-activity-list strong\s*{[^}]*-webkit-line-clamp:\s*2;/s);
  });

  it('renders the board metrics row with the dot-matrix display numerals', () => {
    expect(styles).toMatch(/\.board-metrics\s*{[\s\S]*grid-auto-flow:\s*column;/s);
    expect(styles).toMatch(/\.board-metrics dd\s*{[\s\S]*font-family:\s*var\(--font-display\);/s);
    expect(styles).toMatch(/\.board-metrics dt\s*{[^}]*color:\s*var\(--text-secondary\);/s);
    expect(styles).toMatch(/\.board-metrics dt\b[\s\S]*text-transform:\s*uppercase;/s);
  });

  it('draws the recent activity timeline with grouped marginalia and a shared dot spine', () => {
    expect(styles).toMatch(/\.context-activity-group\s*{[\s\S]*grid-template-columns:\s*2\.3rem\s+minmax\(0,\s*1fr\);/s);
    expect(styles).toMatch(/\.context-activity-group\s*\+\s*\.context-activity-group\s*{[\s\S]*border-top:\s*1px dashed var\(--border\);/s);
    expect(styles).toMatch(/\.context-activity-entries\s*{[\s\S]*gap:\s*0\.6rem;/s);
    expect(styles).toMatch(/\.context-activity-entries:has\(>\s*li\s*\+\s*li\)::before\s*{[\s\S]*background:\s*var\(--border\);/s);
    expect(styles).toMatch(/\.context-activity-entry\s*{[\s\S]*grid-template-columns:\s*7px\s+minmax\(0,\s*1fr\);/s);
    expect(styles).toMatch(/\.context-activity-time\s*{[\s\S]*font-family:\s*var\(--font-mono\);/s);
    expect(styles).toMatch(/\.context-activity-dot\s*{[^}]*border-radius:\s*999px;/s);
  });

  it('lights the sidebar repo rows with a leading status glyph', () => {
    expect(styles).toMatch(/\.project-status-dot\s*{[^}]*border-radius:\s*999px;/s);
    expect(styles).toMatch(/\.project-status-dot\[data-status="in_progress"\][\s\S]*background:\s*var\(--accent\);/s);
    expect(styles).toMatch(/\.project-row-lead\s*{[^}]*display:\s*inline-flex;/s);
  });

  it('prunes dashboard-era selectors that are no longer rendered', () => {
    expect(styles).not.toMatch(/\.board-stats\b/);
    expect(styles).not.toMatch(/\.workspace-grid\b/);
    expect(styles).not.toMatch(/\.workspace-main\b/);
    expect(styles).not.toMatch(/\.workspace-side\b/);
    expect(styles).not.toMatch(/\.focus-panel\b/);
    expect(styles).not.toMatch(/\.plan-panel\b/);
    expect(styles).not.toMatch(/\.timeline-panel\b/);
  });
});
