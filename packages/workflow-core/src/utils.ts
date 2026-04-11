import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import lockfile from 'proper-lockfile';
import YAML from 'yaml';
import type { z } from 'zod';

export type WorkflowPaths = ReturnType<typeof getWorkflowPaths>;

export function getWorkflowPaths(root: string) {
  const workflowDir = path.join(root, '.project-workflow');
  const localDir = path.join(workflowDir, 'local');

  return {
    root,
    workflowDir,
    localDir,
    manifestPath: path.join(workflowDir, 'manifest.yaml'),
    planPath: path.join(workflowDir, 'plan.yaml'),
    decisionsPath: path.join(workflowDir, 'decisions.md'),
    runtimePath: path.join(localDir, 'runtime.yaml'),
    sessionsPath: path.join(localDir, 'sessions.yaml'),
    activityPath: path.join(localDir, 'activity.jsonl'),
    proposedDecisionsPath: path.join(localDir, 'decisions-proposed.yaml'),
    handoffPath: path.join(localDir, 'handoff.md'),
  };
}

export async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export async function readTextIfExists(targetPath: string) {
  if (!(await pathExists(targetPath))) {
    return null;
  }

  return fs.readFile(targetPath, 'utf8');
}

export async function readYamlFile<T>(targetPath: string, schema: z.ZodType<T>) {
  const raw = await fs.readFile(targetPath, 'utf8');
  const parsed = YAML.parse(raw);
  return schema.parse(parsed);
}

export async function writeYamlAtomic(targetPath: string, data: unknown) {
  const dir = path.dirname(targetPath);
  const fileName = path.basename(targetPath);
  const tempPath = path.join(dir, `.${fileName}.${crypto.randomUUID()}.tmp`);
  const body = YAML.stringify(data, { indent: 2, lineWidth: 0 });
  await ensureDir(dir);
  await fs.writeFile(tempPath, body, 'utf8');
  await fs.rename(tempPath, targetPath);
}

export async function writeTextAtomic(targetPath: string, body: string) {
  const dir = path.dirname(targetPath);
  const fileName = path.basename(targetPath);
  const tempPath = path.join(dir, `.${fileName}.${crypto.randomUUID()}.tmp`);
  await ensureDir(dir);
  await fs.writeFile(tempPath, body, 'utf8');
  await fs.rename(tempPath, targetPath);
}

export async function appendJsonLine(targetPath: string, data: unknown) {
  await ensureDir(path.dirname(targetPath));
  await fs.appendFile(targetPath, `${JSON.stringify(data)}\n`, 'utf8');
}

export async function readJsonLines<T>(targetPath: string): Promise<T[]> {
  const raw = await readTextIfExists(targetPath);
  if (!raw) {
    return [];
  }

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function withProjectLock<T>(root: string, callback: () => Promise<T>) {
  const paths = getWorkflowPaths(root);
  await ensureDir(paths.localDir);
  const release = await lockfile(paths.localDir, {
    realpath: false,
    retries: {
      retries: 12,
      factor: 1.3,
      minTimeout: 25,
      maxTimeout: 150,
    },
  });

  try {
    return await callback();
  } finally {
    await release();
  }
}

export async function readGitBranch(root: string) {
  const headPath = path.join(root, '.git', 'HEAD');
  const head = await readTextIfExists(headPath);
  if (!head) {
    return null;
  }

  const trimmed = head.trim();
  if (!trimmed.startsWith('ref:')) {
    return trimmed;
  }

  const refPath = trimmed.replace(/^ref:\s*/, '');
  const parts = refPath.split('/');
  return parts.at(-1) ?? null;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
