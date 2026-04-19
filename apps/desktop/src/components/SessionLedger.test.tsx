import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SessionLedger from './SessionLedger';
import type { SessionBoardRow } from '../lib/session-board';

const rows: SessionBoardRow[] = [
  {
    sessionId: 'session-1',
    sessionTitle: 'projectctl session',
    projectRoot: '/Users/light/Projects/trading',
    projectName: 'trading',
    stepId: null,
    stepTitle: 'No step claimed',
    summary: 'Write the initial problem statement and success criteria.',
    status: 'active',
    displayState: 'needs-step',
    displayLabel: 'unclaimed',
    stepState: 'unclaimed',
    lastUpdatedAt: '2026-04-18T23:34:53.000Z',
  },
];

describe('SessionLedger', () => {
  it('renders explicit step-claim language for active sessions without ownership', () => {
    const html = renderToStaticMarkup(
      <SessionLedger
        rows={rows}
        selectedSessionId="session-1"
        onSelectSession={() => {}}
        formatRelativeTime={() => '52 minutes ago'}
      />,
    );

    expect(html).toContain('projectctl session');
    expect(html).toContain('unclaimed');
    expect(html).toContain('trading');
    expect(html).toContain('No step claimed');
    expect(html).not.toContain('No owned step');
  });
});
