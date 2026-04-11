import process from 'node:process';

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  addBlocker,
  appendActivityEvent,
  clearBlocker,
  completeStep,
  ensureSession,
  getProject,
  listProjects,
  proposeDecision,
  refreshHandoff,
  startStep,
  syncPlan,
  updateRuntime,
} from '@parallel/workflow-core';

const indexDbPath = process.env.PROJECT_WORKFLOW_INDEX_DB;
const watchedRoots = (process.env.PROJECT_WORKFLOW_WATCH_ROOTS ?? '')
  .split(process.platform === 'win32' ? ';' : ':')
  .map((root) => root.trim())
  .filter(Boolean);

const sourceSchema = z.enum(['mcp', 'agent', 'cli', 'desktop', 'human', 'system']);

const server = new McpServer(
  {
    name: 'project-workflow-os',
    version: '0.1.0',
  },
  {
    capabilities: {
      logging: {},
    },
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
  async ({ roots }) => {
    const projects = await listProjects(roots && roots.length > 0 ? roots : watchedRoots, indexDbPath);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(projects, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  'get_project',
  {
    title: 'Get project',
    description:
      'Return manifest, canonical plan, runtime focus, sessions, recent activity, blockers, pending proposals, and handoff text for a project.',
    inputSchema: z.object({
      root: z.string(),
    }),
  },
  async ({ root }) => {
    const project = await getProject(root);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(project, null, 2),
        },
      ],
    };
  },
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
  async ({ root, actor, source, sessionId, sessionTitle, phases }) => {
    const result = await syncPlan({
      root,
      actor,
      source,
      sessionId,
      sessionTitle,
      phases,
      indexDbPath,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, actor, source, sessionId, sessionTitle, branch }) => {
    const result = await ensureSession({
      root,
      actor,
      source,
      sessionId,
      sessionTitle,
      branch,
      indexDbPath,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, actor, source, summary, patch, eventType }) => {
    const result = await updateRuntime({
      root,
      actor,
      source,
      patch,
      summary,
      eventType,
      indexDbPath,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, actor, source, sessionId, sessionTitle, type, summary, stepId, subtaskId, payload }) => {
    const result = await appendActivityEvent(
      root,
      {
        actor,
        source,
        sessionId,
        sessionTitle,
        type,
        summary,
        stepId,
        subtaskId,
        payload,
        indexDbPath,
      },
      indexDbPath,
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, stepId, actor, source, sessionId, sessionTitle, branch }) => {
    const result = await startStep(
      root,
      stepId,
      { actor, source, sessionId, sessionTitle, branch },
      indexDbPath,
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, stepId, actor, source, sessionId, sessionTitle, branch }) => {
    const result = await completeStep(
      root,
      stepId,
      { actor, source, sessionId, sessionTitle, branch },
      indexDbPath,
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, actor, source, sessionId, sessionTitle, branch, blocker, clear }) => {
    const result = clear
      ? await clearBlocker(
          root,
          blocker,
          { actor, source, sessionId, sessionTitle, branch },
          indexDbPath,
        )
      : await addBlocker(
          root,
          blocker ?? 'Unnamed blocker',
          { actor, source, sessionId, sessionTitle, branch },
          indexDbPath,
        );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, actor, source }) => {
    const result = await refreshHandoff(root, { actor, source }, indexDbPath);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
  async ({ root, actor, source, sessionId, sessionTitle, title, context, decision, impact }) => {
    const result = await proposeDecision(
      root,
      { title, context, decision, impact },
      { actor, source, sessionId, sessionTitle },
      indexDbPath,
    );
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
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
