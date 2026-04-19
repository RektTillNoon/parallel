import { memo } from 'react';

import { compactActivityEntries } from '../lib/activity';
import type { BoardProjectDetail, ProjectSummary } from '../lib/types';
import type { SessionBoardDisplayState, SessionBoardRow } from '../lib/session-board';

export function resolveLastTouchedPhrase(value: string | null | undefined) {
  if (!value) {
    return 'Never touched';
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return 'Never touched';
  }

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes === 1) return '1 minute ago';
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
  const hours = Math.round(diffMinutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks === 1) return '1 week ago';
  if (weeks < 5) return `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

type FocusViewProps = {
  project: ProjectSummary;
  detail: BoardProjectDetail | null;
  session: SessionBoardRow | null;
  summary: string;
};

function statusBadge(state: SessionBoardDisplayState, label: string) {
  if (state === 'active') {
    return null;
  }
  return (
    <span className={`focus-badge focus-badge-${state}`}>
      {label}
    </span>
  );
}

export default memo(function FocusView({ project, detail, session, summary }: FocusViewProps) {
  const lastTouchedAt = session?.lastUpdatedAt ?? project.lastUpdatedAt;
  const compact = detail ? compactActivityEntries(detail.recentActivity) : { entries: [], hiddenCount: 0 };

  return (
    <section className="focus">
      <header className="focus-head">
        <p className="focus-kicker">Last touched</p>
        <h2 className="focus-when">{resolveLastTouchedPhrase(lastTouchedAt)}</h2>
        <div className="focus-context">
          <span className="focus-project">{project.name}</span>
          {session?.branch ? <span className="focus-meta">{session.branch}</span> : null}
          {session
            ? statusBadge(session.displayState, session.displayLabel)
            : null}
        </div>
      </header>

      <article className="focus-step">
        <p className="focus-step-label">Working on</p>
        <p className="focus-step-body">{summary}</p>
      </article>

      <section className="focus-feed" aria-label="Recent activity">
        <header className="focus-feed-head">
          <h3>Recent activity</h3>
          {compact.entries.length > 0 ? (
            <span className="focus-feed-count">{compact.entries.length}</span>
          ) : null}
        </header>
        {compact.entries.length === 0 ? (
          <p className="focus-feed-empty">Nothing logged yet.</p>
        ) : (
          <ol className="focus-feed-list">
            {compact.entries.map((entry, index) => (
              <li
                className="focus-feed-entry"
                key={`${entry.timestamp}-${index}`}
              >
                <time className="focus-feed-time" dateTime={entry.timestamp}>
                  {entry.bucket}
                </time>
                <span
                  className="focus-feed-dot"
                  data-source={entry.source}
                  style={{ ['--entry-hue' as string]: `${(index * 47) % 360}` }}
                  aria-hidden="true"
                />
                <span className="focus-feed-text">{entry.summary}</span>
              </li>
            ))}
            {compact.hiddenCount > 0 ? (
              <li className="focus-feed-more">+{compact.hiddenCount} more</li>
            ) : null}
          </ol>
        )}
      </section>

      <footer className="focus-foot">
        <code className="focus-path">{project.root}</code>
      </footer>
    </section>
  );
});
