import { memo } from 'react';

import type { ActivityEvent } from '../lib/types';
import type { ProjectDetail } from '../lib/types';

function toSortTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

export function getRecentActivityEntries(recentActivity: ActivityEvent[]) {
  return [...recentActivity]
    .sort((left, right) => toSortTimestamp(right.timestamp) - toSortTimestamp(left.timestamp))
    .slice(0, 3);
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
        <div className="context-activity-list">
          {getRecentActivityEntries(detail.recentActivity).map((event, index) => (
            <article
              key={`${event.timestamp}-${event.actor}-${event.type}-${event.session_id ?? 'none'}-${event.step_id ?? 'none'}-${index}`}
            >
              <strong>{event.summary}</strong>
            </article>
          ))}
        </div>
      </section>
    </aside>
  );
});
