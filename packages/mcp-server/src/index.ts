import process from 'node:process';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const indexDbPath = process.env.PROJECT_WORKFLOW_INDEX_DB;
const watchedRoots = (process.env.PROJECT_WORKFLOW_WATCH_ROOTS ?? '')
  .split(process.platform === 'win32' ? ';' : ':')
  .map((root) => root.trim())
  .filter(Boolean);
const extension = process.platform === 'win32' ? '.exe' : '';
const binaryCandidates = [
  process.env.PARALLEL_PROJECTCTL_BINARY,
  path.resolve(__dirname, `../../../target/release/projectctl${extension}`),
  path.resolve(__dirname, `../../../target/debug/projectctl${extension}`),
].filter((value): value is string => Boolean(value));

const sourceSchema = z.enum(['mcp', 'agent', 'cli', 'desktop', 'human', 'system']);

function runProjectctl(args: string[]) {
  const resolvedBinary = binaryCandidates.find((candidate) => fs.existsSync(candidate));
  if (!resolvedBinary) {
    throw new Error(
      'Failed to launch Rust projectctl: native binary not found. Build the workspace first or set PARALLEL_PROJECTCTL_BINARY.',
    );
  }

  const result = spawnSync(resolvedBinary, [...args, '--json'], {
    encoding: 'utf8',
    env: process.env,
  });

  if (result.error) {
    throw new Error(`Failed to launch Rust projectctl: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `projectctl exited ${result.status}`;
    throw new Error(message);
  }

  return JSON.parse(result.stdout);
}

function textResponse(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const server = new McpServer(
  {
    name: 'project-workflow-os',
    version: '0.1.0',
  },
  {
    capabilities: { logging: {} },
    instructions:
      'This server exposes agent-safe project workflow operations. Parallel owns the canonical plan, sessions, and execution history.',
  },
);

server.registerTool(
  'list_projects',
  {
    title: 'List projects',
    description: 'List initialized and uninitialized projects under watched roots.',
    inputSchema: z.object({
      roots: z.array(z.string()).optional(),
    }),
  },
  async ({ roots }) => textResponse(runProjectctl(['list', ...(roots && roots.length > 0 ? roots : watchedRoots)])),
);

server.registerTool(
  'get_project',
  {
    title: 'Get project',
    description:
      'Return manifest, canonical plan, runtime focus, sessions, recent activity, blockers, pending proposals, and handoff text for a project.',
    inputSchema: z.object({ root: z.string() }),
  },
  async ({ root }) => textResponse(runProjectctl(['show', '--root', root])),
);

server.registerTool(
  'sync_plan',
  {
    title: 'Sync plan',
    description: 'Replace the canonical ordered project plan with the supplied phased plan.',
    inputSchema: z.object({
      root: z.string(),
      actor: z.string().default('mcp-agent'),
      source: sourceSchema.default('mcp'),
      sessionId: z.string().optional(),
      sessionTitle: z.string().optional(),
      phases: z.array(
        z.object({
          id: z.string().optional(),
          title: z.string(),
          steps: z.array(
            z.object({
              id: z.string().optional(),
              title: z.string(),
              summary: z.string().optional(),
              details: z.array(z.string()).optional(),
              depends_on: z.array(z.string()).optional(),
              subtasks: z
                .array(
                  z.object({
                    id: z.string().optional(),
                    title: z.string(),
                    status: z.enum(['todo', 'done']).optional(),
                  }),
                )
                .optional(),
            }),
          ),
        }),
      ),
    }),
  },
  async ({ root, actor, source, sessionId, sessionTitle, phases }) =>
    textResponse(
      runProjectctl([
        'plan',
        'sync',
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...(sessionTitle ? ['--session-title', sessionTitle] : []),
        '--plan',
        JSON.stringify({ phases }),
      ]),
    ),
);

server.registerTool(
  'ensure_session',
  {
    title: 'Ensure session',
    description: 'Create or resume a workflow session for later step and activity writes.',
    inputSchema: z.object({
      root: z.string(),
      actor: z.string().default('mcp-agent'),
      source: sourceSchema.default('mcp'),
      sessionId: z.string().optional(),
      sessionTitle: z.string().optional(),
      branch: z.string().optional(),
    }),
  },
  async ({ root, actor, source, sessionId, sessionTitle, branch }) =>
    textResponse(
      runProjectctl([
        'session',
        'ensure',
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...(sessionTitle ? ['--session-title', sessionTitle] : []),
        ...(branch ? ['--branch', branch] : []),
      ]),
    ),
);

server.registerTool(
  'update_runtime',
  {
    title: 'Update runtime',
    description: 'Merge a validated runtime patch into the project runtime state.',
    inputSchema: z.object({
      root: z.string(),
      actor: z.string().default('mcp-agent'),
      source: sourceSchema.default('mcp'),
      summary: z.string(),
      patch: z.record(z.string(), z.unknown()),
      eventType: z.string().optional(),
    }),
  },
  async ({ root, actor, source, summary, patch, eventType }) =>
    textResponse(
      runProjectctl([
        'runtime',
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        '--summary',
        summary,
        '--patch',
        JSON.stringify(patch),
        ...(eventType ? ['--event-type', eventType] : []),
      ]),
    ),
);

server.registerTool(
  'append_activity',
  {
    title: 'Append activity',
    description: 'Append a structured activity event, optionally linked to a session, step, or subtask.',
    inputSchema: z.object({
      root: z.string(),
      actor: z.string(),
      source: sourceSchema,
      sessionId: z.string().optional(),
      sessionTitle: z.string().optional(),
      type: z.string(),
      summary: z.string(),
      stepId: z.string().optional(),
      subtaskId: z.string().optional(),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
  },
  async ({ root, actor, source, sessionId, sessionTitle, type, summary, stepId, subtaskId, payload }) =>
    textResponse(
      runProjectctl([
        'activity',
        'add',
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        '--type',
        type,
        '--summary',
        summary,
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...(sessionTitle ? ['--session-title', sessionTitle] : []),
        ...(stepId ? ['--step-id', stepId] : []),
        ...(subtaskId ? ['--subtask-id', subtaskId] : []),
        ...(payload ? ['--payload', JSON.stringify(payload)] : []),
      ]),
    ),
);

server.registerTool(
  'start_step',
  {
    title: 'Start step',
    description: 'Move a step into in-progress state and claim ownership for a session.',
    inputSchema: z.object({
      root: z.string(),
      stepId: z.string(),
      actor: z.string().default('mcp-agent'),
      source: z.enum(['mcp', 'agent']).default('mcp'),
      sessionId: z.string().optional(),
      sessionTitle: z.string().optional(),
      branch: z.string().optional(),
    }),
  },
  async ({ root, stepId, actor, source, sessionId, sessionTitle, branch }) =>
    textResponse(
      runProjectctl([
        'step',
        'start',
        stepId,
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...(sessionTitle ? ['--session-title', sessionTitle] : []),
        ...(branch ? ['--branch', branch] : []),
      ]),
    ),
);

server.registerTool(
  'complete_step',
  {
    title: 'Complete step',
    description: 'Mark a step done and advance runtime focus to the next actionable step.',
    inputSchema: z.object({
      root: z.string(),
      stepId: z.string(),
      actor: z.string().default('mcp-agent'),
      source: z.enum(['mcp', 'agent', 'desktop', 'human']).default('mcp'),
      sessionId: z.string().optional(),
      sessionTitle: z.string().optional(),
      branch: z.string().optional(),
    }),
  },
  async ({ root, stepId, actor, source, sessionId, sessionTitle, branch }) =>
    textResponse(
      runProjectctl([
        'step',
        'done',
        stepId,
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...(sessionTitle ? ['--session-title', sessionTitle] : []),
        ...(branch ? ['--branch', branch] : []),
      ]),
    ),
);

server.registerTool(
  'set_blocker',
  {
    title: 'Set blocker',
    description: 'Add or clear a blocker on the current runtime state.',
    inputSchema: z.object({
      root: z.string(),
      actor: z.string().default('mcp-agent'),
      source: z.enum(['mcp', 'agent', 'desktop', 'human']).default('mcp'),
      sessionId: z.string().optional(),
      sessionTitle: z.string().optional(),
      branch: z.string().optional(),
      blocker: z.string().optional(),
      clear: z.boolean().default(false),
    }),
  },
  async ({ root, actor, source, sessionId, sessionTitle, branch, blocker, clear }) =>
    textResponse(
      runProjectctl([
        'blocker',
        clear ? 'clear' : 'add',
        ...(blocker ? [blocker] : []),
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...(sessionTitle ? ['--session-title', sessionTitle] : []),
        ...(branch ? ['--branch', branch] : []),
      ]),
    ),
);

server.registerTool(
  'refresh_handoff',
  {
    title: 'Refresh handoff',
    description: 'Regenerate the handoff snapshot for a project.',
    inputSchema: z.object({
      root: z.string(),
      actor: z.string().default('mcp-agent'),
      source: z.enum(['mcp', 'agent']).default('mcp'),
    }),
  },
  async ({ root, actor, source }) =>
    textResponse(runProjectctl(['handoff', 'refresh', '--root', root, '--actor', actor, '--source', source])),
);

server.registerTool(
  'propose_decision',
  {
    title: 'Propose decision',
    description: 'Create a pending decision proposal for later human acceptance.',
    inputSchema: z.object({
      root: z.string(),
      actor: z.string().default('mcp-agent'),
      source: z.enum(['mcp', 'agent']).default('mcp'),
      sessionId: z.string().optional(),
      sessionTitle: z.string().optional(),
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      impact: z.string(),
    }),
  },
  async ({ root, actor, source, sessionId, sessionTitle, title, context, decision, impact }) =>
    textResponse(
      runProjectctl([
        'decision',
        'propose',
        '--root',
        root,
        '--actor',
        actor,
        '--source',
        source,
        ...(sessionId ? ['--session-id', sessionId] : []),
        ...(sessionTitle ? ['--session-title', sessionTitle] : []),
        '--title',
        title,
        '--context',
        context,
        '--decision',
        decision,
        '--impact',
        impact,
      ]),
    ),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('project workflow MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in MCP server:', error);
  process.exit(1);
});
