import { memo } from 'react';

import type { SessionBoardRow } from '../lib/session-board';

type SessionLedgerProps = {
  rows: SessionBoardRow[];
  selectedSessionId: string | null;
  onSelectSession: (row: SessionBoardRow) => void;
  formatRelativeTime: (value: string | null | undefined) => string;
};

export default memo(function SessionLedger({
  rows,
  selectedSessionId,
  onSelectSession,
  formatRelativeTime,
}: SessionLedgerProps) {
  return (
    <section className="session-ledger" aria-label="Active sessions">
      {rows.map((row) => (
        <button
          key={row.sessionId}
          type="button"
          className={`session-ledger-row ${row.sessionId === selectedSessionId ? 'is-selected' : ''}`}
          aria-pressed={row.sessionId === selectedSessionId}
          onClick={() => onSelectSession(row)}
        >
          <div className="session-ledger-copy">
            <div className="session-ledger-title">
              <strong>{row.sessionTitle}</strong>
              <span className={`session-ledger-status status-${row.status}`}>{row.status}</span>
            </div>
            <div className="session-ledger-meta">
              {row.projectName} · {row.stepTitle}
            </div>
            <div className="session-ledger-summary">{row.summary}</div>
          </div>
          <span className="session-ledger-time">{formatRelativeTime(row.lastUpdatedAt)}</span>
        </button>
      ))}
    </section>
  );
});
