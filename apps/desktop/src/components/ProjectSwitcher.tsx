import { memo } from 'react';

import type { ProjectSummaryWithLight } from '../lib/project-light';
import type { ProjectSummary } from '../lib/types';

export function compactDuration(value: string | null | undefined) {
  if (!value) {
    return '—';
  }

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
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  return `${Math.round(days / 30)}mo`;
}

export function sortProjectsByRecency(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((left, right) => {
    const leftStamp = left.lastUpdatedAt ? Date.parse(left.lastUpdatedAt) : 0;
    const rightStamp = right.lastUpdatedAt ? Date.parse(right.lastUpdatedAt) : 0;
    return rightStamp - leftStamp;
  });
}

export function hideNestedProjects(projects: ProjectSummary[]): ProjectSummary[] {
  const roots = projects
    .map((project) => project.root.replace(/\/+$/, ''))
    .sort((left, right) => left.length - right.length);
  const kept = new Set<string>();
  for (const candidate of roots) {
    const nested = Array.from(kept).some((ancestor) => candidate.startsWith(`${ancestor}/`));
    if (!nested) {
      kept.add(candidate);
    }
  }
  return projects.filter((project) => kept.has(project.root.replace(/\/+$/, '')));
}

type ProjectSwitcherProps = {
  projects: ProjectSummaryWithLight[];
  selectedRoot: string | null;
  onSelectProject: (project: ProjectSummaryWithLight) => void;
  onOpenSettings: () => void;
  settingsOpen: boolean;
};

export default memo(function ProjectSwitcher({
  projects,
  selectedRoot,
  onSelectProject,
  onOpenSettings,
  settingsOpen,
}: ProjectSwitcherProps) {
  const ordered = sortProjectsByRecency(projects);

  return (
    <aside className="switcher">
      <header className="switcher-head">
        <h1 className="brand-mark">parallel</h1>
      </header>
      <nav className="switcher-list" aria-label="Projects">
        {ordered.map((project) => {
          const selected = selectedRoot === project.root;
          return (
            <button
              key={project.root}
              type="button"
              className={`switcher-item ${selected ? 'is-selected' : ''}`.trim()}
              aria-pressed={selected}
              aria-label={`${project.name}, ${project.lightLabel}`}
              title={`${project.name}, ${project.lightLabel}`}
              onClick={() => onSelectProject(project)}
            >
              <span className="switcher-dot" data-status={project.lightState} aria-hidden="true" />
              <span className="switcher-name">{project.name}</span>
              <span className="switcher-time">{compactDuration(project.lastUpdatedAt)}</span>
            </button>
          );
        })}
      </nav>
      <footer className="switcher-foot">
        <button
          type="button"
          className={`settings-button ${settingsOpen ? 'is-open' : ''}`.trim()}
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          aria-controls="settings-dialog"
          aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
          onClick={onOpenSettings}
        >
          Settings
        </button>
      </footer>
    </aside>
  );
});
