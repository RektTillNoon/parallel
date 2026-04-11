import type {
  ActivityEvent,
  DecisionProposal,
  Manifest,
  Plan,
  RuntimeState,
  WorkflowSession,
} from './schemas';
import { findCurrentStepTitle } from './project-helpers';

interface HandoffInput {
  manifest: Manifest;
  plan: Plan;
  runtime: RuntimeState;
  sessions: WorkflowSession[];
  activity: ActivityEvent[];
  proposals: DecisionProposal[];
}

export function generateHandoff(input: HandoffInput) {
  const currentStep = findCurrentStepTitle(input.plan, input.runtime.current_step_id);
  const recentActivity = input.activity.slice(-8).reverse();
  const blockers = input.runtime.blockers;
  const openQuestions = input.proposals.map((proposal) => `Review proposal: ${proposal.title}`);
  const activeSessions = input.sessions.filter((session) => session.status === 'active');

  const lines = [
    '# Project Handoff',
    '',
    '## Current state',
    `- Project: ${input.manifest.name}`,
    `- Status: ${input.runtime.status}`,
    `- Current step: ${currentStep ?? 'None'}`,
    `- Next action: ${input.runtime.next_action || 'No next action recorded.'}`,
    `- Active branch: ${input.runtime.active_branch ?? 'Unknown'}`,
    `- Last updated: ${input.runtime.last_updated_at}`,
    '',
    '## Active sessions',
  ];

  if (activeSessions.length === 0) {
    lines.push('- None.');
  } else {
    for (const session of activeSessions) {
      lines.push(
        `- ${session.title} (${session.actor}/${session.source})${session.owned_step_id ? ` -> ${session.owned_step_id}` : ''}`,
      );
    }
  }

  lines.push('', '## What changed');

  if (recentActivity.length === 0) {
    lines.push('- No recent activity.');
  } else {
    for (const event of recentActivity) {
      const context = [event.session_id, event.step_id].filter(Boolean).join(' / ');
      lines.push(
        `- ${event.timestamp}: ${event.summary} (${event.actor}/${event.source}${context ? ` | ${context}` : ''})`,
      );
    }
  }

  lines.push('', '## Blockers');

  if (blockers.length === 0) {
    lines.push('- None.');
  } else {
    for (const blocker of blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  lines.push('', '## Open questions');

  if (openQuestions.length === 0) {
    lines.push('- None.');
  } else {
    for (const question of openQuestions) {
      lines.push(`- ${question}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
