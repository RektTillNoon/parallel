import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FRAGMENT_SHADER } from './ShaderBackdrop';

const source = readFileSync(new URL('./ShaderBackdrop.tsx', import.meta.url), 'utf8');

describe('ShaderBackdrop shader', () => {
  it('anchors the backdrop in a soft japanese palette with luminous glassy color fields', () => {
    expect(FRAGMENT_SHADER).not.toContain('mix(vec3(1.0), blended');
    expect(FRAGMENT_SHADER).toContain('sumiInk');
    expect(FRAGMENT_SHADER).toContain('sakuraMist');
    expect(FRAGMENT_SHADER).toContain('seijiMint');
    expect(FRAGMENT_SHADER).toContain('aizome');
    expect(FRAGMENT_SHADER).toContain('shojiGlow');
  });

  it('uses drifting gradient washes instead of neon structures', () => {
    expect(FRAGMENT_SHADER).toContain('mistOrb');
    expect(FRAGMENT_SHADER).toContain('rippleField');
    expect(FRAGMENT_SHADER).toContain('float t = u_time * 0.085;');
    expect(FRAGMENT_SHADER).toContain('vec3 glow =');
    expect(FRAGMENT_SHADER).not.toContain('signColumn');
    expect(FRAGMENT_SHADER).not.toContain('laserRail');
    expect(FRAGMENT_SHADER).not.toContain('kintsugiTrace');
  });

  it('keeps a moderate device-pixel ratio cap for a smooth background pass', () => {
    expect(source).toContain('Math.min(window.devicePixelRatio || 1, 1.75)');
  });
});
