import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface IndexedProjectSummary {
  id: string | null;
  name: string;
  root: string;
  kind: string | null;
  owner: string | null;
  tags: string[];
  initialized: boolean;
  status: string;
  stale: boolean;
  missing: boolean;
  currentStepId: string | null;
  currentStepTitle: string | null;
  blockerCount: number;
  totalStepCount: number;
  completedStepCount: number;
  activeSessionCount: number;
  focusSessionId: string | null;
  lastUpdatedAt: string | null;
  nextAction: string | null;
  activeBranch: string | null;
  pendingProposalCount: number;
  lastSeenAt: string | null;
}

export interface ProjectIndexRecord extends IndexedProjectSummary {
  watchedRoot: string;
}

function sqlEscape(value: string) {
  return value.replace(/'/g, "''");
}

function sqlValue(value: string | number | boolean | null) {
  if (value === null) {
    return 'NULL';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  return `'${sqlEscape(value)}'`;
}

function runSql(dbPath: string, sql: string, json = false) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const args = json ? ['-json', dbPath, sql] : [dbPath, sql];
  return execFileSync('sqlite3', args, {
    encoding: 'utf8',
  });
}

function ensureColumn(dbPath: string, column: string, definition: string) {
  const raw = runSql(dbPath, 'PRAGMA table_info(projects);', true).trim();
  const columns = raw ? (JSON.parse(raw) as Array<{ name: string }>) : [];
  if (columns.some((entry) => entry.name === column)) {
    return;
  }

  runSql(dbPath, `ALTER TABLE projects ADD COLUMN ${column} ${definition};`);
}

function ensureSchema(dbPath: string) {
  runSql(
    dbPath,
    `
      CREATE TABLE IF NOT EXISTS projects (
        root TEXT PRIMARY KEY,
        watched_root TEXT NOT NULL,
        id TEXT,
        name TEXT NOT NULL,
        kind TEXT,
        owner TEXT,
        tags_json TEXT NOT NULL,
        initialized INTEGER NOT NULL,
        status TEXT NOT NULL,
        stale INTEGER NOT NULL,
        missing INTEGER NOT NULL,
        current_step_id TEXT,
        current_step_title TEXT,
        blocker_count INTEGER NOT NULL,
        total_step_count INTEGER NOT NULL DEFAULT 0,
        completed_step_count INTEGER NOT NULL DEFAULT 0,
        active_session_count INTEGER NOT NULL DEFAULT 0,
        focus_session_id TEXT,
        last_updated_at TEXT,
        next_action TEXT,
        active_branch TEXT,
        pending_proposal_count INTEGER NOT NULL,
        last_seen_at TEXT
      );
    `,
  );

  ensureColumn(dbPath, 'total_step_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(dbPath, 'completed_step_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(dbPath, 'active_session_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(dbPath, 'focus_session_id', 'TEXT');
}

export class IndexStore {
  constructor(private readonly dbPath: string) {
    ensureSchema(dbPath);
  }

  syncProject(summary: ProjectIndexRecord) {
    runSql(
      this.dbPath,
      `
        INSERT INTO projects (
          root, watched_root, id, name, kind, owner, tags_json, initialized, status, stale, missing,
          current_step_id, current_step_title, blocker_count, total_step_count, completed_step_count,
          active_session_count, focus_session_id, last_updated_at, next_action, active_branch,
          pending_proposal_count, last_seen_at
        ) VALUES (
          ${sqlValue(summary.root)},
          ${sqlValue(summary.watchedRoot)},
          ${sqlValue(summary.id)},
          ${sqlValue(summary.name)},
          ${sqlValue(summary.kind)},
          ${sqlValue(summary.owner)},
          ${sqlValue(JSON.stringify(summary.tags))},
          ${sqlValue(summary.initialized)},
          ${sqlValue(summary.status)},
          ${sqlValue(summary.stale)},
          ${sqlValue(summary.missing)},
          ${sqlValue(summary.currentStepId)},
          ${sqlValue(summary.currentStepTitle)},
          ${sqlValue(summary.blockerCount)},
          ${sqlValue(summary.totalStepCount)},
          ${sqlValue(summary.completedStepCount)},
          ${sqlValue(summary.activeSessionCount)},
          ${sqlValue(summary.focusSessionId)},
          ${sqlValue(summary.lastUpdatedAt)},
          ${sqlValue(summary.nextAction)},
          ${sqlValue(summary.activeBranch)},
          ${sqlValue(summary.pendingProposalCount)},
          ${sqlValue(summary.lastSeenAt)}
        )
        ON CONFLICT(root) DO UPDATE SET
          watched_root = excluded.watched_root,
          id = excluded.id,
          name = excluded.name,
          kind = excluded.kind,
          owner = excluded.owner,
          tags_json = excluded.tags_json,
          initialized = excluded.initialized,
          status = excluded.status,
          stale = excluded.stale,
          missing = excluded.missing,
          current_step_id = excluded.current_step_id,
          current_step_title = excluded.current_step_title,
          blocker_count = excluded.blocker_count,
          total_step_count = excluded.total_step_count,
          completed_step_count = excluded.completed_step_count,
          active_session_count = excluded.active_session_count,
          focus_session_id = excluded.focus_session_id,
          last_updated_at = excluded.last_updated_at,
          next_action = excluded.next_action,
          active_branch = excluded.active_branch,
          pending_proposal_count = excluded.pending_proposal_count,
          last_seen_at = excluded.last_seen_at;
      `,
    );
  }

  markMissingProjects(watchedRoots: string[], presentRoots: Set<string>) {
    const candidates = this.listProjects(watchedRoots);
    for (const candidate of candidates) {
      if (!presentRoots.has(candidate.root)) {
        runSql(
          this.dbPath,
          `UPDATE projects SET stale = 1, missing = 1 WHERE root = ${sqlValue(candidate.root)};`,
        );
      }
    }
  }

  listProjects(watchedRoots: string[]) {
    if (watchedRoots.length === 0) {
      return [] as ProjectIndexRecord[];
    }

    const raw = runSql(
      this.dbPath,
      `SELECT * FROM projects WHERE watched_root IN (${watchedRoots
        .map((root) => sqlValue(root))
        .join(', ')}) ORDER BY name COLLATE NOCASE;`,
      true,
    ).trim();

    if (!raw) {
      return [];
    }

    const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: (row.id as string | null) ?? null,
      name: String(row.name),
      root: String(row.root),
      watchedRoot: String(row.watched_root),
      kind: (row.kind as string | null) ?? null,
      owner: (row.owner as string | null) ?? null,
      tags: JSON.parse(String(row.tags_json)) as string[],
      initialized: Boolean(row.initialized),
      status: String(row.status),
      stale: Boolean(row.stale),
      missing: Boolean(row.missing),
      currentStepId: (row.current_step_id as string | null) ?? null,
      currentStepTitle: (row.current_step_title as string | null) ?? null,
      blockerCount: Number(row.blocker_count),
      totalStepCount: Number(row.total_step_count ?? 0),
      completedStepCount: Number(row.completed_step_count ?? 0),
      activeSessionCount: Number(row.active_session_count ?? 0),
      focusSessionId: (row.focus_session_id as string | null) ?? null,
      lastUpdatedAt: (row.last_updated_at as string | null) ?? null,
      nextAction: (row.next_action as string | null) ?? null,
      activeBranch: (row.active_branch as string | null) ?? null,
      pendingProposalCount: Number(row.pending_proposal_count),
      lastSeenAt: (row.last_seen_at as string | null) ?? null,
    }));
  }
}
