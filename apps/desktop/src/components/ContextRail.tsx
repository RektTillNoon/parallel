import { memo } from 'react';

import type { ActivityEvent } from '../lib/types';
import type { ProjectDetail } from '../lib/types';

export function getRecentActivityEntries(recentActivity: ActivityEvent[]) {
  return [...recentActivity]
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .slice(0, 3);
}

type ContextRailProps = {
  detail: ProjectDetail | null;
  currentStepTitle: string;
};

export default memo(function ContextRail({ detail, currentStepTitle }: ContextRailProps) {
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
        <p>{detail.runtime.next_action}</p>
      </section>
      <section>
        <p className="context-rail-label">Recent activity</p>
        <div className="context-activity-list">
          {getRecentActivityEntries(detail.recentActivity).map((event) => (
            <article key={`${event.timestamp}-${event.summary}`}>
              <strong>{event.summary}</strong>
            </article>
          ))}
        </div>
      </section>
    </aside>
  );
});
