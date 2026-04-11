import { z } from 'zod';

export const STEP_STATUS_VALUES = ['todo', 'in_progress', 'blocked', 'done'] as const;
export const SUBTASK_STATUS_VALUES = ['todo', 'done'] as const;
export const SESSION_STATUS_VALUES = ['active', 'paused', 'done'] as const;
export const ACTIVITY_SOURCE_VALUES = [
  'cli',
  'mcp',
  'desktop',
  'agent',
  'human',
  'system',
] as const;

const nonEmptyString = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });

const stringArray = z.array(nonEmptyString).default([]);

export const stepStatusSchema = z.enum(STEP_STATUS_VALUES);
export const subtaskStatusSchema = z.enum(SUBTASK_STATUS_VALUES);
export const runtimeStatusSchema = stepStatusSchema;
export const sessionStatusSchema = z.enum(SESSION_STATUS_VALUES);
export const activitySourceSchema = z.enum(ACTIVITY_SOURCE_VALUES);

export const manifestSchema = z.object({
  version: z.number().int().positive().default(1),
  id: nonEmptyString,
  name: nonEmptyString,
  root: nonEmptyString,
  kind: nonEmptyString,
  owner: nonEmptyString,
  tags: stringArray,
  created_at: isoDateTime,
});

export const subtaskSchema = z.preprocess(
  (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      id: typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : undefined,
      title: raw.title,
      status: raw.status ?? 'todo',
    };
  },
  z.object({
    id: nonEmptyString,
    title: nonEmptyString,
    status: subtaskStatusSchema.default('todo'),
  }),
);

export const stepSchema = z.preprocess(
  (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const acceptance = Array.isArray(raw.acceptance) ? raw.acceptance : [];
    const notes = Array.isArray(raw.notes) ? raw.notes : [];
    const explicitDetails = Array.isArray(raw.details) ? raw.details : [];
    const fallbackDetails = [...acceptance, ...notes]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);

    return {
      id: raw.id,
      title: raw.title,
      summary:
        typeof raw.summary === 'string' && raw.summary.trim().length > 0
          ? raw.summary
          : typeof acceptance[0] === 'string'
            ? acceptance[0]
            : '',
      status: raw.status ?? 'todo',
      depends_on: raw.depends_on ?? [],
      details: explicitDetails.length > 0 ? explicitDetails : fallbackDetails,
      subtasks: raw.subtasks ?? [],
      owner_session_id: raw.owner_session_id ?? null,
      completed_at: raw.completed_at ?? null,
      completed_by: raw.completed_by ?? null,
    };
  },
  z.object({
    id: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().trim().default(''),
    status: stepStatusSchema,
    depends_on: stringArray,
    details: stringArray,
    subtasks: z.array(subtaskSchema).default([]),
    owner_session_id: z.string().trim().min(1).nullable().default(null),
    completed_at: z.string().datetime({ offset: true }).nullable().default(null),
    completed_by: z.string().trim().min(1).nullable().default(null),
  }),
);

export const phaseSchema = z.preprocess(
  (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      id: raw.id,
      title: raw.title,
      steps: raw.steps ?? [],
    };
  },
  z.object({
    id: nonEmptyString,
    title: nonEmptyString,
    steps: z.array(stepSchema).default([]),
  }),
);

export const planSchema = z
  .object({
    version: z.number().int().positive().default(2),
    phases: z.array(phaseSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const phaseIds = new Set<string>();
    const stepIds = new Set<string>();

    for (const [phaseIndex, phase] of plan.phases.entries()) {
      if (phaseIds.has(phase.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate phase id "${phase.id}"`,
          path: ['phases', phaseIndex, 'id'],
        });
      }
      phaseIds.add(phase.id);

      for (const [stepIndex, step] of phase.steps.entries()) {
        if (stepIds.has(step.id)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate step id "${step.id}"`,
            path: ['phases', phaseIndex, 'steps', stepIndex, 'id'],
          });
        }
        stepIds.add(step.id);
      }
    }

    for (const [phaseIndex, phase] of plan.phases.entries()) {
      for (const [stepIndex, step] of phase.steps.entries()) {
        for (const dependency of step.depends_on) {
          if (!stepIds.has(dependency)) {
            ctx.addIssue({
              code: 'custom',
              message: `Unknown dependency "${dependency}"`,
              path: ['phases', phaseIndex, 'steps', stepIndex, 'depends_on'],
            });
          }
        }
      }
    }
  });

export const runtimeSchema = z.preprocess(
  (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      version: raw.version ?? 2,
      current_phase_id: raw.current_phase_id ?? null,
      current_step_id: raw.current_step_id ?? null,
      focus_session_id: raw.focus_session_id ?? null,
      next_action: raw.next_action ?? '',
      status: raw.status ?? 'todo',
      blockers: raw.blockers ?? [],
      last_updated_at: raw.last_updated_at,
      active_branch: raw.active_branch ?? null,
      active_session_ids: raw.active_session_ids ?? [],
    };
  },
  z.object({
    version: z.number().int().positive().default(2),
    current_phase_id: z.string().trim().min(1).nullable().default(null),
    current_step_id: z.string().trim().min(1).nullable().default(null),
    focus_session_id: z.string().trim().min(1).nullable().default(null),
    next_action: z.string().trim(),
    status: runtimeStatusSchema,
    blockers: stringArray,
    last_updated_at: isoDateTime,
    active_branch: z.string().trim().nullable().default(null),
    active_session_ids: stringArray,
  }),
);

export const sessionSchema = z.preprocess(
  (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      id: raw.id,
      title: raw.title ?? '',
      actor: raw.actor,
      source: raw.source,
      branch: raw.branch ?? null,
      status: raw.status ?? 'active',
      owned_step_id: raw.owned_step_id ?? null,
      observed_step_ids: raw.observed_step_ids ?? [],
      started_at: raw.started_at,
      last_updated_at: raw.last_updated_at,
    };
  },
  z.object({
    id: nonEmptyString,
    title: z.string().trim().default(''),
    actor: nonEmptyString,
    source: activitySourceSchema,
    branch: z.string().trim().nullable().default(null),
    status: sessionStatusSchema.default('active'),
    owned_step_id: z.string().trim().min(1).nullable().default(null),
    observed_step_ids: stringArray,
    started_at: isoDateTime,
    last_updated_at: isoDateTime,
  }),
);

export const sessionsFileSchema = z.object({
  version: z.number().int().positive().default(1),
  sessions: z.array(sessionSchema).default([]),
});

export const activityEventSchema = z.preprocess(
  (input) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    return {
      timestamp: raw.timestamp,
      actor: raw.actor,
      source: raw.source,
      project_id: raw.project_id,
      session_id: raw.session_id ?? null,
      step_id: raw.step_id ?? null,
      subtask_id: raw.subtask_id ?? null,
      type: raw.type,
      summary: raw.summary,
      payload: raw.payload ?? {},
    };
  },
  z.object({
    timestamp: isoDateTime,
    actor: nonEmptyString,
    source: activitySourceSchema,
    project_id: nonEmptyString,
    session_id: z.string().trim().min(1).nullable().default(null),
    step_id: z.string().trim().min(1).nullable().default(null),
    subtask_id: z.string().trim().min(1).nullable().default(null),
    type: nonEmptyString,
    summary: nonEmptyString,
    payload: z.unknown().default({}),
  }),
);

export const decisionProposalSchema = z.object({
  id: nonEmptyString,
  proposed_at: isoDateTime,
  proposed_by: nonEmptyString,
  title: nonEmptyString,
  context: z.string().trim(),
  decision: z.string().trim(),
  impact: z.string().trim(),
  status: z.enum(['proposed', 'accepted', 'rejected']),
});

export const decisionProposalsFileSchema = z.object({
  version: z.number().int().positive().default(1),
  proposals: z.array(decisionProposalSchema).default([]),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Subtask = z.infer<typeof subtaskSchema>;
export type RuntimeState = z.infer<typeof runtimeSchema>;
export type WorkflowSession = z.infer<typeof sessionSchema>;
export type SessionsFile = z.infer<typeof sessionsFileSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type DecisionProposal = z.infer<typeof decisionProposalSchema>;
export type DecisionProposalsFile = z.infer<typeof decisionProposalsFileSchema>;
