import type { Phase, Plan, Step, Subtask } from './schemas';

export interface LocatedStep {
  phase: Phase;
  phaseIndex: number;
  step: Step;
  stepIndex: number;
}

export interface IndexedStep extends LocatedStep {
  order: number;
}

export function locateStep(plan: Plan, stepId: string): LocatedStep | null {
  for (const [phaseIndex, phase] of plan.phases.entries()) {
    for (const [stepIndex, step] of phase.steps.entries()) {
      if (step.id === stepId) {
        return { phase, phaseIndex, step, stepIndex };
      }
    }
  }

  return null;
}

export function getIndexedSteps(plan: Plan): IndexedStep[] {
  const indexed: IndexedStep[] = [];
  let order = 1;

  for (const [phaseIndex, phase] of plan.phases.entries()) {
    for (const [stepIndex, step] of phase.steps.entries()) {
      indexed.push({
        phase,
        phaseIndex,
        step,
        stepIndex,
        order,
      });
      order += 1;
    }
  }

  return indexed;
}

export function findCurrentStepTitle(plan: Plan, currentStepId: string | null) {
  if (!currentStepId) {
    return null;
  }

  return locateStep(plan, currentStepId)?.step.title ?? null;
}

export function getAllSteps(plan: Plan) {
  return plan.phases.flatMap((phase) => phase.steps);
}

export function getPlanProgress(plan: Plan) {
  const steps = getAllSteps(plan);
  const total = steps.length;
  const completed = steps.filter((step) => step.status === 'done').length;
  return { total, completed };
}

export function getNextActionableStep(plan: Plan) {
  const steps = getAllSteps(plan);

  for (const step of steps) {
    if (step.status === 'done') {
      continue;
    }

    const dependenciesMet = step.depends_on.every((dependency) => {
      return steps.find((candidate) => candidate.id === dependency)?.status === 'done';
    });

    if (dependenciesMet) {
      return locateStep(plan, step.id);
    }
  }

  return null;
}

export function normalizePlanInProgressStates(plan: Plan, activeStepId: string | null) {
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      if (step.id === activeStepId) {
        continue;
      }

      if (step.status === 'in_progress' || step.status === 'blocked') {
        step.status = step.completed_at ? 'done' : 'todo';
      }

      if (step.owner_session_id && step.id !== activeStepId) {
        step.owner_session_id = null;
      }
    }
  }
}

export function clonePlan(plan: Plan): Plan {
  return structuredClone(plan);
}

export function normalizeSubtaskIds(subtasks: Subtask[]) {
  const seen = new Set<string>();
  const normalized: Subtask[] = [];

  for (const subtask of subtasks) {
    let nextId = subtask.id;
    let suffix = 2;

    while (seen.has(nextId)) {
      nextId = `${subtask.id}-${suffix}`;
      suffix += 1;
    }

    seen.add(nextId);
    normalized.push({ ...subtask, id: nextId });
  }

  return normalized;
}
