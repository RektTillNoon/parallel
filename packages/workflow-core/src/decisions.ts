export interface AcceptedDecision {
  date: string;
  title: string;
  context: string;
  decision: string;
  impact: string;
}

export function buildAcceptedDecisionMarkdown(entries: AcceptedDecision[]) {
  const sections = entries.map((entry) => {
    return [
      `## ${entry.date} - ${entry.title}`,
      '',
      '### Context',
      entry.context || '_No context provided._',
      '',
      '### Decision',
      entry.decision || '_No decision text provided._',
      '',
      '### Impact',
      entry.impact || '_No impact recorded._',
      '',
    ].join('\n');
  });

  return ['# Accepted Decisions', '', ...sections].join('\n').trimEnd() + '\n';
}

export function parseAcceptedDecisions(markdown: string): AcceptedDecision[] {
  const normalized = markdown.replace(/^# Accepted Decisions\s*/m, '').trim();
  if (!normalized) {
    return [];
  }

  const chunks = normalized
    .split(/\n##\s+/)
    .map((chunk, index) => (index === 0 ? chunk.replace(/^##\s+/, '') : chunk))
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.map((chunk) => {
    const [headingLine, ...rest] = chunk.split('\n');
    const [date, ...titleParts] = headingLine.split(' - ');
    const body = rest.join('\n');

    const getSection = (label: string) => {
      const match = body.match(
        new RegExp(`### ${label}\\n([\\s\\S]*?)(?=\\n### |$)`, 'm'),
      );
      return match?.[1]?.trim() ?? '';
    };

    return {
      date: date.trim(),
      title: titleParts.join(' - ').trim(),
      context: getSection('Context'),
      decision: getSection('Decision'),
      impact: getSection('Impact'),
    };
  });
}
