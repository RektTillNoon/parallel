use std::{fs, path::Path};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};

use crate::models::{ProjectIndexRecord, ProjectSummary};

pub struct IndexStore {
    db_path: String,
}

impl IndexStore {
    pub fn new(db_path: impl Into<String>) -> Result<Self> {
        let store = Self { db_path: db_path.into() };
        store.ensure_schema()?;
        Ok(store)
    }

    fn connection(&self) -> Result<Connection> {
        if let Some(parent) = Path::new(&self.db_path).parent() {
            fs::create_dir_all(parent)?;
        }
        Connection::open(&self.db_path).with_context(|| format!("open sqlite {}", self.db_path))
    }

    fn ensure_schema(&self) -> Result<()> {
        let conn = self.connection()?;
        conn.execute_batch(
            r#"
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
            "#,
        )?;
        Ok(())
    }

    pub fn sync_project(&self, record: &ProjectIndexRecord) -> Result<()> {
        let conn = self.connection()?;
        conn.execute(
            r#"
            INSERT INTO projects (
              root, watched_root, id, name, kind, owner, tags_json, initialized, status, stale, missing,
              current_step_id, current_step_title, blocker_count, total_step_count, completed_step_count,
              active_session_count, focus_session_id, last_updated_at, next_action, active_branch,
              pending_proposal_count, last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
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
              last_seen_at = excluded.last_seen_at
            "#,
            params![
                record.summary.root,
                record.watched_root,
                record.summary.id,
                record.summary.name,
                record.summary.kind,
                record.summary.owner,
                serde_json::to_string(&record.summary.tags)?,
                record.summary.initialized as i64,
                record.summary.status,
                record.summary.stale as i64,
                record.summary.missing as i64,
                record.summary.current_step_id,
                record.summary.current_step_title,
                record.summary.blocker_count,
                record.summary.total_step_count,
                record.summary.completed_step_count,
                record.summary.active_session_count,
                record.summary.focus_session_id,
                record.summary.last_updated_at,
                record.summary.next_action,
                record.summary.active_branch,
                record.summary.pending_proposal_count,
                record.summary.last_seen_at,
            ],
        )?;
        Ok(())
    }

    pub fn mark_missing_projects(&self, watched_roots: &[String], present_roots: &[String]) -> Result<()> {
        let candidates = self.list_projects(watched_roots)?;
        let present: std::collections::HashSet<&str> = present_roots.iter().map(|value| value.as_str()).collect();
        let conn = self.connection()?;
        for candidate in candidates {
            if !present.contains(candidate.summary.root.as_str()) {
                conn.execute(
                    "UPDATE projects SET stale = 1, missing = 1 WHERE root = ?1",
                    params![candidate.summary.root],
                )?;
            }
        }
        Ok(())
    }

    pub fn list_projects(&self, watched_roots: &[String]) -> Result<Vec<ProjectIndexRecord>> {
        if watched_roots.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = (0..watched_roots.len())
            .map(|index| format!("?{}", index + 1))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT * FROM projects WHERE watched_root IN ({placeholders}) ORDER BY name COLLATE NOCASE"
        );
        let conn = self.connection()?;
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(watched_roots.iter()), |row| {
            let tags_json: String = row.get("tags_json")?;
            let summary = ProjectSummary {
                id: row.get("id")?,
                name: row.get("name")?,
                root: row.get("root")?,
                kind: row.get("kind")?,
                owner: row.get("owner")?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                initialized: row.get::<_, i64>("initialized")? != 0,
                status: row.get("status")?,
                stale: row.get::<_, i64>("stale")? != 0,
                missing: row.get::<_, i64>("missing")? != 0,
                current_step_id: row.get("current_step_id")?,
                current_step_title: row.get("current_step_title")?,
                blocker_count: row.get("blocker_count")?,
                total_step_count: row.get("total_step_count")?,
                completed_step_count: row.get("completed_step_count")?,
                active_session_count: row.get("active_session_count")?,
                focus_session_id: row.get("focus_session_id")?,
                last_updated_at: row.get("last_updated_at")?,
                next_action: row.get("next_action")?,
                active_branch: row.get("active_branch")?,
                pending_proposal_count: row.get("pending_proposal_count")?,
                last_seen_at: row.get("last_seen_at")?,
            };
            Ok(ProjectIndexRecord {
                summary,
                watched_root: row.get("watched_root")?,
            })
        })?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}
