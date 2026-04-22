import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('desktop tauri script', () => {
  it('pins Cargo artifacts to the workspace target directory', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.tauri).toContain(
      'CARGO_TARGET_DIR=../../target',
    );
  });
});
