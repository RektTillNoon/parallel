import { describe, expect, it } from 'vitest';

import { buildServeArgs, parseReadyPort } from './bridge-smoke.mjs';

describe('bridge smoke helpers', () => {
  it('parses the bound port emitted by projectctl', () => {
    expect(parseReadyPort('noise\nAGENT_BRIDGE_READY 51234\n')).toBe(51234);
  });

  it('builds the local serve-http command with an ephemeral port', () => {
    expect(buildServeArgs('/tmp/index.sqlite', '/tmp/root')).toEqual([
      'mcp',
      'serve-http',
      '--port',
      '0',
      '--token',
      'parallel-smoke-token',
      '--index-db',
      '/tmp/index.sqlite',
      '--roots',
      '/tmp/root',
    ]);
  });
});
