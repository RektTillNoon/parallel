import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesPath = new URL('./styles.css', import.meta.url);
const bundledDisplayFontPath = new URL('../public/fonts/doto-700.ttf', import.meta.url);
const styles = readFileSync(stylesPath, 'utf8');

describe('single-focus design system', () => {
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

  it('defines the vibrant-minimal token palette with a vivid accent', () => {
    expect(styles).toMatch(/color-scheme:\s*dark;/);
    expect(styles).toMatch(/--bg:\s*oklch\(/);
    expect(styles).toMatch(/--surface:\s*oklch\(/);
    expect(styles).toMatch(/--ink:\s*oklch\(/);
    expect(styles).toMatch(/--muted:\s*oklch\(/);
    expect(styles).toMatch(/--line:\s*oklch\(/);
    expect(styles).toMatch(/--accent:\s*oklch\([^)]+42\)/);
    expect(styles).toMatch(/--accent-soft:\s*color-mix/);
  });

  it('uses a two-column shell with the switcher on the left', () => {
    expect(styles).toMatch(
      /\.shell\s*{[^}]*grid-template-columns:\s*minmax\(14rem,\s*16rem\)\s+minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(/\.switcher\s*{[\s\S]*border-right:\s*1px solid var\(--line\);/s);
    expect(styles).toMatch(/\.stage\s*{[\s\S]*max-width:\s*62rem;/s);
  });

  it('keeps the Doto display wordmark and a mono utility stack', () => {
    expect(styles).toMatch(/--font-display:\s*"Doto",\s*"Space Mono"/s);
    expect(styles).toMatch(/\.brand-mark\s*{[^}]*font-family:\s*var\(--font-display\);/s);
    expect(styles).toMatch(
      /\.brand-mark\s*{[^}]*font-size:\s*clamp\(1\.9rem,\s*2\.8vw,\s*2\.4rem\);/s,
    );
    expect(styles).toMatch(/\.focus-kicker\s*{[\s\S]*font-family:\s*var\(--font-mono\);/s);
    expect(styles).toMatch(/\.switcher-time\s*{[\s\S]*font-family:\s*var\(--font-mono\);/s);
  });

  it('leads the stage with a compact relative-time headline', () => {
    expect(styles).toMatch(
      /\.focus-when\s*{[^}]*font-size:\s*clamp\(1\.75rem,\s*4\.5vw,\s*2\.8rem\);/s,
    );
    expect(styles).toMatch(/\.focus-when\s*{[^}]*letter-spacing:\s*-0\.045em;/s);
  });

  it('renders the recent-activity feed as a vertical rainbow timeline', () => {
    expect(styles).toMatch(/\.focus-feed-list\s*{[\s\S]*position:\s*relative;/s);
    expect(styles).toMatch(/\.focus-feed-list::before\s*{[\s\S]*background:\s*var\(--line\);/s);
    expect(styles).toMatch(
      /\.focus-feed-entry\s*{[\s\S]*grid-template-columns:\s*2\.25rem\s+9px\s+minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(/\.focus-feed-time\s*{[\s\S]*font-family:\s*var\(--font-mono\);/s);
    expect(styles).toMatch(/\.focus-feed-dot\s*{[^}]*border-radius:\s*999px;/s);
    expect(styles).toMatch(
      /\.focus-feed-dot\s*{[\s\S]*?background:\s*oklch\([\s\S]*?var\(--entry-hue/s,
    );
    expect(styles).not.toMatch(/\.focus-feed-dot\[data-source/);
  });

  it('mounts the shader backdrop behind the shell', () => {
    expect(styles).toMatch(/\.shader-backdrop\s*{[\s\S]*position:\s*fixed;/s);
    expect(styles).toMatch(/\.shader-backdrop\s*{[\s\S]*pointer-events:\s*none;/s);
    expect(styles).toMatch(
      /\.shell\s*>\s*\*:not\(:is\(\.shader-backdrop,\s*\.settings-modal-layer\)\)/s,
    );
  });

  it('keeps the settings overlay as a centered fixed layer above the shell layout', () => {
    expect(styles).toMatch(/\.settings-modal-layer\s*{[\s\S]*position:\s*fixed;/s);
    expect(styles).toMatch(/\.settings-modal-layer\s*{[\s\S]*place-items:\s*center;/s);
    expect(styles).toMatch(/\.settings-modal-layer\s*{[\s\S]*z-index:\s*7;/s);
    expect(styles).toMatch(/\.settings-modal-layer\s*{[\s\S]*padding:\s*1\.5rem;/s);
    expect(styles).toMatch(/\.settings-modal\s*{[\s\S]*width:\s*min\(38\.5rem,\s*calc\(100vw\s*-\s*2\.25rem\)\);/s);
    expect(styles).toMatch(/\.settings-modal\s*{[\s\S]*max-height:\s*calc\(100vh\s*-\s*2\.25rem\);/s);
    expect(styles).toMatch(/\.settings-panel\s*{[\s\S]*grid-template-rows:\s*auto minmax\(0,\s*1fr\);/s);
    expect(styles).toMatch(/\.settings-panel\s*{[\s\S]*overflow:\s*hidden;/s);
    expect(styles).toMatch(/\.settings-modal-layer\s*{[\s\S]*background:\s*color-mix\(in oklab,\s*var\(--bg\)\s*42%,\s*black\);/s);
    expect(styles).toMatch(/\.settings-panel\s*{[\s\S]*background:\s*color-mix\(in oklab,\s*var\(--bg\)\s*70%,\s*var\(--surface\)\);/s);
    expect(styles).toMatch(/\.settings-panel\s*{[\s\S]*position:\s*relative;/s);
    expect(styles).toMatch(/\.settings-panel\s*{[\s\S]*isolation:\s*isolate;/s);
    expect(styles).toMatch(/\.settings-scroll\s*{[\s\S]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.settings-scroll\s*{[\s\S]*scrollbar-gutter:\s*stable;/s);
    expect(styles).toMatch(/\.settings-scroll\s*{[\s\S]*padding:\s*0\.55rem\s+1\.2rem\s+1\.2rem;/s);
    expect(styles).toMatch(/\.settings-head\s*{[\s\S]*padding:\s*1\.15rem\s+1\.2rem\s+0\.95rem;/s);
    expect(styles).toMatch(/\.settings-head\s*{[\s\S]*border-bottom:\s*1px solid color-mix/s);
    expect(styles).toMatch(/\.settings-quiet-row\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    expect(styles).toMatch(/\.settings-action-details\s*>\s*summary\s*{[\s\S]*color:\s*var\(--ink\);/s);
    expect(styles).toMatch(/\.settings-inline-details\s*>\s*summary\s*{[\s\S]*cursor:\s*pointer;/s);
    expect(styles).not.toMatch(/\.shell\s*>\s*\*:not\(\.shader-backdrop\)[\s\S]*position:\s*relative;/s);
    expect(styles).toMatch(/\.shell\s*>\s*\*:not\(:is\(\.shader-backdrop,\s*\.settings-modal-layer\)\)/s);
  });

  it('renders the stage sync as a compact floating control', () => {
    expect(styles).toMatch(/\.stage\s*{[\s\S]*position:\s*relative;/s);
    expect(styles).toMatch(/\.stage-sync\s*{[\s\S]*position:\s*absolute;/s);
    expect(styles).not.toMatch(/\.stage-head\b/);
  });

  it('lights the switcher items with a tiny status dot and selection wash', () => {
    expect(styles).toMatch(/\.switcher-dot\s*{[^}]*border-radius:\s*999px;/s);
    expect(styles).toMatch(/\.switcher-dot\s*{[\s\S]*background:\s*var\(--warn\);/s);
    expect(styles).toMatch(/\.switcher-dot\s*{[\s\S]*box-shadow:\s*0 0 10px/);
    expect(styles).toMatch(
      /\.switcher-item:hover:not\(:disabled\)\s*{[\s\S]*border-color:\s*color-mix\(in oklab,\s*var\(--line-strong\)\s*72%,\s*transparent\);/s,
    );
    expect(styles).toMatch(
      /\.switcher-dot\[data-status="live"\][\s\S]*background:\s*var\(--good\);/s,
    );
    expect(styles).toMatch(
      /\.switcher-dot\[data-status="resumable"\][\s\S]*background:\s*var\(--warn\);/s,
    );
    expect(styles).toMatch(
      /\.switcher-dot\[data-status="blocked"\][\s\S]*background:\s*var\(--danger\);/s,
    );
    expect(styles).toMatch(
      /\.switcher-dot\[data-status="done"\][\s\S]*background:\s*var\(--line-strong\);/s,
    );
    expect(styles).toMatch(
      /\.switcher-dot\[data-status="uninitialized"\][\s\S]*background:\s*var\(--danger\);/s,
    );
    expect(styles).toMatch(
      /\.switcher-item\.is-selected\s*{[\s\S]*background:\s*color-mix\(in oklab,\s*var\(--surface\)\s*88%,\s*transparent\);/s,
    );
    expect(styles).not.toMatch(/\.switcher-item\.is-selected\s+\.\switcher-name\s*{[\s\S]*var\(--accent-ink\)/s);
    expect(styles).not.toMatch(/\.focus-project::before\b/);
    expect(styles).toMatch(/\.focus-path\s*{[\s\S]*color:\s*var\(--ink\);/s);
    expect(styles).toMatch(/\.focus-path\s*{[\s\S]*opacity:\s*0\.82;/s);
  });

  it('honors reduced-motion and keeps body overflow well-behaved', () => {
    expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/s);
    expect(styles).toMatch(/body\s*{[\s\S]*overflow-x:\s*hidden;[\s\S]*overflow-y:\s*auto;/s);
    expect(styles).not.toMatch(/\.switcher\s*{[^}]*overflow:\s*auto;/s);
    expect(styles).not.toMatch(/\.stage\s*{[^}]*overflow:\s*auto;/s);
  });

  it('keeps the fixed left rail instead of collapsing into a top project picker on smaller windows', () => {
    expect(styles).not.toMatch(/@media\s*\(max-width:\s*960px\)\s*{[\s\S]*\.shell\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    expect(styles).not.toMatch(/@media\s*\(max-width:\s*960px\)\s*{[\s\S]*\.switcher\s*{[\s\S]*border-bottom:/s);
    expect(styles).not.toMatch(/@media\s*\(max-width:\s*960px\)\s*{[\s\S]*\.switcher-head\s*{[\s\S]*display:\s*none;/s);
    expect(styles).not.toMatch(/@media\s*\(max-width:\s*960px\)\s*{[\s\S]*\.switcher-list\s*{[\s\S]*display:\s*none;/s);
    expect(styles).not.toMatch(/\.switcher-compact-shell\b/);
    expect(styles).not.toMatch(/\.switcher-compact-picker\b/);
  });

  it('lets the serene settings rows collapse cleanly on narrow modal widths', () => {
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.settings-modal-layer\s*{[\s\S]*padding:\s*0\.9rem;/s,
    );
    expect(styles).toMatch(
      /@media\s*\(max-width:\s*560px\)\s*{[\s\S]*\.settings-head\s*{[\s\S]*padding:\s*1rem\s+1rem\s+0\.85rem;/s,
    );
  });

  it('anchors settings actions directly under their copy instead of keeping a detached rail', () => {
    expect(styles).toMatch(/\.settings-row-footer\s*{[\s\S]*display:\s*flex;/s);
    expect(styles).toMatch(/\.settings-row-footer\s*{[\s\S]*justify-content:\s*space-between;/s);
    expect(styles).toMatch(/\.settings-row-footer\s*{[\s\S]*align-items:\s*flex-end;/s);
    expect(styles).toMatch(/\.settings-row-footer\s*{[\s\S]*flex-wrap:\s*wrap;/s);
    expect(styles).toMatch(/\.settings-row-footer-owned\s*{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/s);
    expect(styles).toMatch(/\.settings-row-footer-owned\s*{[\s\S]*align-items:\s*start;/s);
    expect(styles).toMatch(/\.settings-row-footer-owned\s*>\s*\.settings-row-meta\s*{[\s\S]*justify-self:\s*start;/s);
    expect(styles).toMatch(/\.settings-row-footer-owned\s*>\s*\.settings-quiet-actions\s*{[\s\S]*justify-self:\s*end;/s);
    expect(styles).toMatch(/\.settings-quiet-actions\s*{[\s\S]*justify-content:\s*flex-start;/s);
    expect(styles).toMatch(/\.settings-quiet-actions\s*{[\s\S]*margin-top:\s*0;/s);
    expect(styles).toMatch(/\.root-row-action\s*{[\s\S]*justify-self:\s*start;/s);
  });

  it('renders the bridge enablement control as a plain toggle instead of another action pill', () => {
    expect(styles).toMatch(/\.settings-toggle-control\s*{[\s\S]*display:\s*inline-flex;/s);
    expect(styles).toMatch(/\.settings-toggle-control\s*{[\s\S]*gap:\s*0\.55rem;/s);
    expect(styles).toMatch(/\.settings-toggle-control input\s*{[\s\S]*accent-color:\s*var\(--accent\);/s);
    expect(styles).not.toMatch(/\.settings-toggle-chip\s*{[\s\S]*background:/s);
  });

  it('normalizes the settings action controls to one shared pill size and type scale', () => {
    expect(styles).toMatch(
      /\.settings-quiet-actions\s*>\s*button,\s*\.settings-action-details\s*>\s*summary\s*{[\s\S]*min-height:\s*2\.35rem;/s,
    );
    expect(styles).toMatch(
      /\.settings-quiet-actions\s*>\s*button,\s*\.settings-action-details\s*>\s*summary\s*{[\s\S]*padding:\s*0\.55rem\s+0\.9rem;/s,
    );
    expect(styles).toMatch(
      /\.settings-quiet-actions\s*>\s*button,\s*\.settings-action-details\s*>\s*summary\s*{[\s\S]*min-width:\s*6rem;/s,
    );
    expect(styles).toMatch(
      /\.settings-quiet-actions\s*>\s*button,\s*\.settings-action-details\s*>\s*summary\s*{[\s\S]*font-size:\s*0\.88rem;/s,
    );
    expect(styles).toMatch(
      /\.settings-quiet-actions\s*>\s*button,\s*\.settings-action-details\s*>\s*summary\s*{[\s\S]*font-weight:\s*600;/s,
    );
  });

  it('treats utilities as a dropdown menu anchored to its trigger', () => {
    expect(styles).toMatch(/\.settings-action-details\s*{[\s\S]*position:\s*relative;/s);
    expect(styles).toMatch(
      /\.settings-action-details\s*>\s*summary\s*{[\s\S]*border-radius:\s*12px;/s,
    );
    expect(styles).toMatch(
      /\.settings-action-details\s*>\s*summary\s*{[\s\S]*border:\s*1px solid var\(--line\);/s,
    );
    expect(styles).toMatch(
      /\.settings-action-details\s*>\s*summary\s*{[\s\S]*background:\s*color-mix\(in oklab,\s*var\(--bg\)\s*84%,\s*var\(--surface\)\);/s,
    );
    expect(styles).toMatch(/\.settings-section\s+\.collapse-content\s*{[\s\S]*overflow:\s*visible;/s);
    expect(styles).toMatch(/\.settings-action-details\[open\]\s*{[\s\S]*z-index:\s*4;/s);
    expect(styles).toMatch(
      /\.settings-action-details\[open\]\s*>\s*\.settings-utility-list\s*{[\s\S]*position:\s*absolute;/s,
    );
    expect(styles).toMatch(
      /\.settings-action-details\[open\]\s*>\s*\.settings-utility-list\s*{[\s\S]*top:\s*calc\(100%\s*\+\s*0\.45rem\);/s,
    );
    expect(styles).toMatch(
      /\.settings-action-details\[open\]\s*>\s*\.settings-utility-list\s*{[\s\S]*right:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.settings-action-details\[open\]\s*>\s*\.settings-utility-list\s*{[\s\S]*min-width:\s*13rem;/s,
    );
    expect(styles).not.toMatch(
      /\.settings-modal button,\s*\.settings-inline-details\s*>\s*summary,\s*\.settings-action-details\s*>\s*summary\s*{[\s\S]*border-radius:\s*999px;/s,
    );
  });

  it('makes inline details triggers visibly expandable instead of reading like stray muted text', () => {
    expect(styles).toMatch(
      /\.settings-inline-details\s*>\s*summary\s*{[\s\S]*display:\s*inline-flex;/s,
    );
    expect(styles).toMatch(
      /\.settings-inline-details\s*>\s*summary\s*{[\s\S]*padding:\s*0\.45rem\s+0\.75rem;/s,
    );
    expect(styles).toMatch(
      /\.settings-inline-details\s*>\s*summary\s*{[\s\S]*border:\s*1px solid var\(--line\);/s,
    );
    expect(styles).toMatch(
      /\.settings-inline-details\s*>\s*summary\s*{[\s\S]*border-radius:\s*12px;/s,
    );
    expect(styles).toMatch(
      /\.settings-inline-details\s*>\s*summary::after\s*{[\s\S]*content:\s*"▾";/s,
    );
    expect(styles).toMatch(
      /\.settings-inline-details\[open\]\s*>\s*summary::after\s*{[\s\S]*transform:\s*rotate\(180deg\);/s,
    );
  });

  it('raises settings readability and makes disabled controls look intentionally inactive', () => {
    expect(styles).toMatch(/\.settings-copy\s*{[\s\S]*color:\s*color-mix\(in oklab,\s*var\(--ink\)\s*84%,\s*var\(--muted\)\);/s);
    expect(styles).toMatch(/\.settings-quiet-kicker\s*{[\s\S]*color:\s*color-mix\(in oklab,\s*var\(--ink\)\s*70%,\s*var\(--muted\)\);/s);
    expect(styles).toMatch(/\.settings-quiet-note\s*{[\s\S]*color:\s*color-mix\(in oklab,\s*var\(--ink\)\s*82%,\s*var\(--muted\)\);/s);
    expect(styles).toMatch(/button:disabled\s*{[\s\S]*opacity:\s*0\.32;/s);
    expect(styles).toMatch(/button:disabled\s*{[\s\S]*color:\s*var\(--subtle\);/s);
  });

  it('prunes dashboard-era selectors that no longer render', () => {
    expect(styles).not.toMatch(/\.command-deck\b/);
    expect(styles).not.toMatch(/\.control-spotlight\b/);
    expect(styles).not.toMatch(/\.board-metrics\b/);
    expect(styles).not.toMatch(/\.board-topline\b/);
    expect(styles).not.toMatch(/\.session-ledger\b/);
    expect(styles).not.toMatch(/\.session-board-layout\b/);
    expect(styles).not.toMatch(/\.context-rail\b/);
    expect(styles).not.toMatch(/\.context-resume-card\b/);
    expect(styles).not.toMatch(/\.context-activity-compact-list\b/);
    expect(styles).not.toMatch(/\.project-row\b/);
    expect(styles).not.toMatch(/\.sidebar-block\b/);
    expect(styles).not.toMatch(/\.sidebar-brand\b/);
    expect(styles).not.toMatch(/\.sidebar-kicker\b/);
    expect(styles).not.toMatch(/\.panel\b(?!-)/);
  });
});
