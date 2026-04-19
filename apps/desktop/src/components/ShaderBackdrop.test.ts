import { describe, expect, it } from 'vitest';

import { FRAGMENT_SHADER } from './ShaderBackdrop';

describe('ShaderBackdrop shader', () => {
  it('anchors the backdrop in a japanese amber horizon with gold and white bloom', () => {
    expect(FRAGMENT_SHADER).not.toContain('mix(vec3(1.0), blended');
    expect(FRAGMENT_SHADER).toContain('sumiBase');
    expect(FRAGMENT_SHADER).toContain('amberHorizon');
    expect(FRAGMENT_SHADER).toContain('goldCurrent');
    expect(FRAGMENT_SHADER).toContain('whiteBloom');
  });

  it('uses electric diagonal currents and bloom instead of ocean-wave motion', () => {
    expect(FRAGMENT_SHADER).toContain('currentRibbon');
    expect(FRAGMENT_SHADER).toContain('bloomField');
    expect(FRAGMENT_SHADER).toContain('scanline');
    expect(FRAGMENT_SHADER).toContain('float t = u_time * 0.11;');
    expect(FRAGMENT_SHADER).toContain('vec3 bloom =');
    expect(FRAGMENT_SHADER).not.toContain('waveBand');
    expect(FRAGMENT_SHADER).not.toContain('deepWater');
  });
});
