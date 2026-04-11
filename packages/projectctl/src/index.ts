#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';

import {
  acceptDecision,
  addBlocker,
  addNote,
  appendActivityEvent,
  clearBlocker,
  completeStep,
  ensureSession,
  getProject,
  initProject,
  listProjects,
  proposeDecision,
  refreshHandoff,
  syncPlan,
  startStep,
  updateRuntime,
} from '@parallel/workflow-core';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const [name, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[name] = true;
      continue;
    }

    flags[name] = next;
    index += 1;
  }

  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, name: string, fallback?: string) {
  const value = flags[name];
  if (typeof value === 'string') {
    return value;
  }
  return fallback;
}

function getRequiredFlag(flags: Record<string, string | boolean>, name: string) {
  const value = getStringFlag(flags, name);
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
}

function resolveActor(flags: Record<string, string | boolean>) {
  const actor = getStringFlag(flags, 'actor') || 'projectctl';
  const source =
    (getStringFlag(flags, 'source') as
      | 'cli'
      | 'mcp'
      | 'desktop'
      | 'agent'
      | 'human'
      | 'system'
      | undefined) ?? 'cli';

  return {
    actor,
    source,
  };
}

function resolveSessionContext(flags: Record<string, string | boolean>) {
  const branchValue = getStringFlag(flags, 'branch');
  return {
    sessionId: getStringFlag(flags, 'session-id'),
    sessionTitle: getStringFlag(flags, 'session-title'),
    branch: branchValue === undefined ? undefined : branchValue,
  };
}

function resolveRoot(flags: Record<string, string | boolean>) {
  return path.resolve(getStringFlag(flags, 'root', process.cwd()) ?? process.cwd());
}

function resolveIndexDb(flags: Record<string, string | boolean>) {
  return getStringFlag(flags, 'index-db', process.env.PROJECT_WORKFLOW_INDEX_DB);
}

function ensureHumanAuthority(flags: Record<string, string | boolean>) {
  const source = getStringFlag(flags, 'source');
  if (source === 'human' || process.env.PROJECT_WORKFLOW_ALLOW_HUMAN_ACTIONS === '1') {
    return;
  }

  throw new Error('decision accept requires explicit human authority via --source human');
}

function resolveRoots(parsed: ParsedArgs) {
  const explicitRoots = parsed.positionals.length > 1 ? parsed.positionals.slice(1) : [];
  if (explicitRoots.length > 0) {
    return explicitRoots.map((root) => path.resolve(root));
  }

  const envRoots = process.env.PROJECT_WORKFLOW_WATCH_ROOTS;
  if (envRoots) {
    return envRoots
      .split(path.delimiter)
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => path.resolve(root));
  }

  return [process.cwd()];
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function printResult(value: unknown, json: boolean) {
  if (json) {
    process.stdout.write(`${JSON.stringify(asJson(value), null, 2)}\n`);
    return;
  }

  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(asJson(value), null, 2)}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, ...rest] = parsed.positionals;
  const json = Boolean(parsed.flags.json);
  const actor = resolveActor(parsed.flags);
  const sessionContext = resolveSessionContext(parsed.flags);
  const indexDbPath = resolveIndexDb(parsed.flags);

  try {
    switch (command) {
      case 'init': {
        const project = await initProject({
          root: resolveRoot(parsed.flags),
          actor: actor.actor,
          source: actor.source,
          name: getStringFlag(parsed.flags, 'name'),
          kind: getStringFlag(parsed.flags, 'kind', 'software'),
          owner: getStringFlag(parsed.flags, 'owner', actor.actor),
          tags: getStringFlag(parsed.flags, 'tags', '')
            ?.split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          indexDbPath,
        });
        printResult(project, json);
        break;
      }
      case 'list': {
        const projects = await listProjects(resolveRoots(parsed), indexDbPath);
        printResult(projects, json);
        break;
      }
      case 'show': {
        const project = await getProject(resolveRoot(parsed.flags));
        printResult(project, json);
        break;
      }
      case 'step': {
        const stepId = rest[0];
        if (!stepId) {
          throw new Error('Missing step id');
        }

        const result =
          subcommand === 'start'
            ? await startStep(
                resolveRoot(parsed.flags),
                stepId,
                { ...actor, ...sessionContext },
                indexDbPath,
              )
            : await completeStep(
                resolveRoot(parsed.flags),
                stepId,
                { ...actor, ...sessionContext },
                indexDbPath,
              );
        printResult(result, json);
        break;
      }
      case 'blocker': {
        const summary = rest.join(' ') || getStringFlag(parsed.flags, 'summary', '') || '';
        if (subcommand === 'add') {
          if (!summary) {
            throw new Error('Missing blocker summary');
          }
          printResult(
            await addBlocker(resolveRoot(parsed.flags), summary, { ...actor, ...sessionContext }, indexDbPath),
            json,
          );
          break;
        }

        printResult(
          await clearBlocker(
            resolveRoot(parsed.flags),
            summary || undefined,
            { ...actor, ...sessionContext },
            indexDbPath,
          ),
          json,
        );
        break;
      }
      case 'note': {
        const summary = rest.join(' ') || getStringFlag(parsed.flags, 'summary', '') || '';
        if (!summary) {
          throw new Error('Missing note summary');
        }
        printResult(
          await addNote(resolveRoot(parsed.flags), summary, { ...actor, ...sessionContext }, indexDbPath),
          json,
        );
        break;
      }
      case 'session': {
        if (subcommand !== 'ensure') {
          throw new Error(`Unknown session subcommand "${subcommand ?? ''}"`);
        }
        printResult(
          await ensureSession({
            root: resolveRoot(parsed.flags),
            ...actor,
            ...sessionContext,
            indexDbPath,
          }),
          json,
        );
        break;
      }
      case 'plan': {
        if (subcommand !== 'sync') {
          throw new Error(`Unknown plan subcommand "${subcommand ?? ''}"`);
        }
        const planArg = getStringFlag(parsed.flags, 'plan');
        if (!planArg) {
          throw new Error('Missing --plan JSON');
        }
        const parsedPlan = JSON.parse(planArg) as { phases: unknown[] } | unknown[];
        const phases = Array.isArray(parsedPlan) ? parsedPlan : parsedPlan.phases;
        if (!Array.isArray(phases)) {
          throw new Error('--plan must be a JSON array of phases or an object with phases');
        }
        printResult(
          await syncPlan({
            root: resolveRoot(parsed.flags),
            phases: phases as never,
            ...actor,
            ...sessionContext,
            indexDbPath,
          }),
          json,
        );
        break;
      }
      case 'activity': {
        if (subcommand !== 'add') {
          throw new Error(`Unknown activity subcommand "${subcommand ?? ''}"`);
        }
        const type = getRequiredFlag(parsed.flags, 'type');
        const summary =
          rest.join(' ') || getStringFlag(parsed.flags, 'summary', '') || '';
        if (!summary) {
          throw new Error('Missing activity summary');
        }
        const payload = getStringFlag(parsed.flags, 'payload');
        printResult(
          await appendActivityEvent(
            resolveRoot(parsed.flags),
            {
              ...actor,
              ...sessionContext,
              type,
              summary,
              stepId: getStringFlag(parsed.flags, 'step-id'),
              subtaskId: getStringFlag(parsed.flags, 'subtask-id'),
              payload: payload ? (JSON.parse(payload) as Record<string, unknown>) : undefined,
              indexDbPath,
            },
            indexDbPath,
          ),
          json,
        );
        break;
      }
      case 'handoff': {
        printResult(await refreshHandoff(resolveRoot(parsed.flags), actor, indexDbPath), json);
        break;
      }
      case 'decision': {
        if (subcommand === 'propose') {
          printResult(
            await proposeDecision(
              resolveRoot(parsed.flags),
              {
                title: getRequiredFlag(parsed.flags, 'title'),
                context: getStringFlag(parsed.flags, 'context', '') ?? '',
                decision: getStringFlag(parsed.flags, 'decision', '') ?? '',
                impact: getStringFlag(parsed.flags, 'impact', '') ?? '',
              },
              { ...actor, ...sessionContext },
              indexDbPath,
            ),
            json,
          );
          break;
        }

        if (subcommand === 'accept') {
          ensureHumanAuthority(parsed.flags);
          const proposalId = rest[0] ?? getStringFlag(parsed.flags, 'proposal-id');
          if (!proposalId) {
            throw new Error('Missing proposal id');
          }
          printResult(await acceptDecision(resolveRoot(parsed.flags), proposalId, actor, indexDbPath), json);
          break;
        }

        throw new Error(`Unknown decision subcommand "${subcommand ?? ''}"`);
      }
      case 'runtime': {
        const patch = getStringFlag(parsed.flags, 'patch');
        if (!patch) {
          throw new Error('Missing --patch JSON');
        }
        const parsedPatch = JSON.parse(patch) as Record<string, unknown>;
        printResult(
          await updateRuntime({
            root: resolveRoot(parsed.flags),
            actor: actor.actor,
            source: actor.source,
            patch: parsedPatch,
            summary: getStringFlag(parsed.flags, 'summary', 'Updated runtime state') ?? 'Updated runtime state',
            eventType: getStringFlag(parsed.flags, 'event-type'),
            indexDbPath,
          }),
          json,
        );
        break;
      }
      default:
        printResult(
          {
            commands: [
              'projectctl init [--root PATH] [--name NAME]',
              'projectctl list [ROOT ...]',
              'projectctl show [--root PATH]',
              'projectctl step start <step-id> [--root PATH]',
              'projectctl step done <step-id> [--root PATH]',
              'projectctl session ensure [--root PATH]',
              'projectctl plan sync --plan JSON [--root PATH]',
              'projectctl activity add --type TYPE [--summary TEXT] [--root PATH]',
              'projectctl blocker add <summary> [--root PATH]',
              'projectctl blocker clear [summary] [--root PATH]',
              'projectctl note add <summary> [--root PATH]',
              'projectctl handoff refresh [--root PATH]',
              'projectctl decision propose --title TITLE --context TEXT --decision TEXT --impact TEXT [--root PATH]',
            ],
          },
          true,
        );
        process.exitCode = command ? 1 : 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    process.exit(1);
  }
}

void main();
