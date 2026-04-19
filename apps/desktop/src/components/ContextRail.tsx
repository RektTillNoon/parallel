import { memo } from 'react';

import type { ActivityEvent } from '../lib/types';
import type { BoardProjectDetail, ProjectSummary } from '../lib/types';
import type { SessionBoardDisplayState } from '../lib/session-board';

export function formatActivityTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return '—';
  }

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;

  const date = new Date(timestamp);
  const month = date.toLocaleString(undefined, { month: 'short' }).toLowerCase();
  return `${month} ${date.getDate()}`;
}

export type CompactActivityEntry = {
  bucket: string;
  summary: string;
  timestamp: string;
  source: ActivityEvent['source'];
};

export function compactActivityEntries(entries: ActivityEvent[], limit = 4) {
  return {
    entries: entries.slice(0, limit).map((entry) => ({
      bucket: formatActivityTime(entry.timestamp),
      summary: entry.summary,
      timestamp: entry.timestamp,
      source: entry.source,
    })),
    hiddenCount: Math.max(0, entries.length - limit),
  };
}

type ContextRailProps = {
  project: ProjectSummary | null;
  detail: BoardProjectDetail | null;
  sessionTitle: string;
  sessionDisplayState: SessionBoardDisplayState;
  sessionStatusLabel: string;
  currentStepTitle: string;
  currentStepSummary: string;
  currentStepOwned: boolean;
};

export default memo(function ContextRail({
  project,
  detail,
  sessionTitle,
  sessionDisplayState,
  sessionStatusLabel,
  currentStepTitle,
  currentStepSummary,
  currentStepOwned,
}: ContextRailProps) {
  if (!project || !detail) {
    return null;
  }

  const recent = compactActivityEntries(detail.recentActivity);

  return (
    <aside className="context-rail">
      <section>
        <p className="context-rail-label">Session</p>
        <div className="context-rail-heading">
          <h2>{sessionTitle}</h2>
          <span className={`status status-${sessionDisplayState}`}>{sessionStatusLabel}</span>
        </div>
        <p className="context-rail-project-name">{project.name}</p>
        <p>{project.root}</p>
        {project.discoveryPath && project.discoveryPath !== project.root ? (
          <p>{project.discoveryPath}</p>
        ) : null}
      </section>
      <section>
        <p className="context-rail-label">Step</p>
        <h3>{currentStepTitle}</h3>
        <p>{currentStepOwned ? currentStepSummary : `Next: ${currentStepSummary}`}</p>
      </section>
      <section>
        <p className="context-rail-label">Recent</p>
        {recent.entries.length === 0 ? (
          <p className="context-activity-empty">Nothing logged yet.</p>
        ) : (
          <ol className="context-activity-compact-list">
            {recent.entries.map((entry, index) => (
              <li
                className="context-activity-compact-entry"
                key={`${entry.timestamp}-${entry.summary}-${index}`}
              >
                <time className="context-activity-compact-time" dateTime={entry.timestamp}>
                  {entry.bucket}
                </time>
                <span
                  className="context-activity-compact-dot"
                  data-source={entry.source}
                  aria-hidden="true"
                />
                <strong>{entry.summary}</strong>
              </li>
            ))}
            {recent.hiddenCount > 0 ? (
              <li className="context-activity-more">+{recent.hiddenCount} more</li>
            ) : null}
          </ol>
        )}
      </section>
    </aside>
  );
});
