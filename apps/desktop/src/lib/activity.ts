import type { ActivityEvent } from './types';

export function formatActivityTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return '—';
  }

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;

  const date = new Date(timestamp);
  const month = date.toLocaleString(undefined, { month: 'short' }).toLowerCase();
  return `${month} ${date.getDate()}`;
}

export type CompactActivityEntry = {
  bucket: string;
  summary: string;
  timestamp: string;
  source: ActivityEvent['source'];
  actor: string;
  type: string;
  sessionId: string | null;
  stepId: string | null;
  blockers: string[];
};

const SUMMARY_CHAR_LIMIT = 90;

export function truncateActivitySummary(value: string, limit = SUMMARY_CHAR_LIMIT): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) {
    return cleaned;
  }
  const sliced = cleaned.slice(0, limit - 1);
  const lastSpace = sliced.lastIndexOf(' ');
  const trimmed = lastSpace > limit * 0.6 ? sliced.slice(0, lastSpace) : sliced;
  return `${trimmed.replace(/[.,;:\-–—]+$/u, '')}…`;
}

export function compactActivityEntries(entries: ActivityEvent[], limit = 8) {
  return {
    entries: entries.slice(0, limit).map((entry) => {
      const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
      const blockers = 'blockers' in payload ? payload.blockers : null;
      const payloadBlockers = Array.isArray(blockers)
        ? blockers.filter((blocker): blocker is string => typeof blocker === 'string')
        : [];

      return {
        bucket: formatActivityTime(entry.timestamp),
        summary: truncateActivitySummary(entry.summary),
        timestamp: entry.timestamp,
        source: entry.source,
        actor: entry.actor,
        type: entry.type,
        sessionId: entry.session_id,
        stepId: entry.step_id,
        blockers: payloadBlockers,
      };
    }),
    hiddenCount: Math.max(0, entries.length - limit),
  };
}
