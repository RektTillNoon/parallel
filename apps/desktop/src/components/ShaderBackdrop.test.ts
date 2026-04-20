import { describe, expect, it } from 'vitest';

import { FRAGMENT_SHADER } from './ShaderBackdrop';

describe('ShaderBackdrop shader', () => {
  it('anchors the backdrop in an oceanic japanese palette with kintsugi gold seams', () => {
    expect(FRAGMENT_SHADER).not.toContain('mix(vec3(1.0), blended');
    expect(FRAGMENT_SHADER).toContain('aiBase');
    expect(FRAGMENT_SHADER).toContain('deepWater');
    expect(FRAGMENT_SHADER).toContain('seijiFoam');
    expect(FRAGMENT_SHADER).toContain('kinGold');
    expect(FRAGMENT_SHADER).toContain('warmShell');
  });

  it('uses layered wave motion and kintsugi crack highlights instead of electric ribbons', () => {
    expect(FRAGMENT_SHADER).toContain('waveBand');
    expect(FRAGMENT_SHADER).toContain('foamField');
    expect(FRAGMENT_SHADER).toContain('kintsugiSeam');
    expect(FRAGMENT_SHADER).toContain('float t = u_time * 0.095;');
    expect(FRAGMENT_SHADER).toContain('vec3 seamGlow =');
    expect(FRAGMENT_SHADER).not.toContain('currentRibbon');
    expect(FRAGMENT_SHADER).not.toContain('bloomField');
  });
});
