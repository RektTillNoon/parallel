import { memo } from 'react';

import type { ActivityEvent } from '../lib/types';
import type { ProjectDetail } from '../lib/types';

const RECENT_ACTIVITY_LIMIT = 5;

function toSortTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function getRecentActivityEntries(recentActivity: ActivityEvent[]) {
  return [...recentActivity]
    .sort((left, right) => toSortTimestamp(right.timestamp) - toSortTimestamp(left.timestamp))
    .slice(0, RECENT_ACTIVITY_LIMIT);
}

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

export type ActivityGroup = {
  bucket: string;
  entries: ActivityEvent[];
};

export function groupActivityEntries(entries: ActivityEvent[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const entry of entries) {
    const bucket = formatActivityTime(entry.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) {
      last.entries.push(entry);
    } else {
      groups.push({ bucket, entries: [entry] });
    }
  }
  return groups;
}

type ContextRailProps = {
  detail: ProjectDetail | null;
  currentStepTitle: string;
  currentStepSummary: string;
};

export default memo(function ContextRail({
  detail,
  currentStepTitle,
  currentStepSummary,
}: ContextRailProps) {
  if (!detail) {
    return null;
  }

  const groups = groupActivityEntries(getRecentActivityEntries(detail.recentActivity));

  return (
    <aside className="context-rail">
      <section>
        <p className="context-rail-label">Selected repo</p>
        <h2>{detail.manifest.name}</h2>
        <p>{detail.manifest.root}</p>
      </section>
      <section>
        <p className="context-rail-label">Current step</p>
        <h3>{currentStepTitle}</h3>
        <p>{currentStepSummary}</p>
      </section>
      <section>
        <p className="context-rail-label">Recent activity</p>
        {groups.length === 0 ? (
          <p className="context-activity-empty">Nothing logged yet.</p>
        ) : (
          <div className="context-activity-list">
            {groups.map((group, groupIndex) => (
              <div
                className="context-activity-group"
                key={`${group.bucket}-${group.entries[0].timestamp}-${groupIndex}`}
              >
                <time
                  className="context-activity-time"
                  dateTime={group.entries[0].timestamp}
                >
                  {group.bucket}
                </time>
                <ol className="context-activity-entries">
                  {group.entries.map((event, index) => (
                    <li
                      className="context-activity-entry"
                      key={`${event.timestamp}-${event.actor}-${event.type}-${event.session_id ?? 'none'}-${event.step_id ?? 'none'}-${index}`}
                    >
                      <span
                        className="context-activity-dot"
                        data-source={event.source}
                        aria-hidden="true"
                      />
                      <strong>{event.summary}</strong>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
});
