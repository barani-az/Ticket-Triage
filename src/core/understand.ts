import type { LlmGateway } from './llm.js';
import type { HintedField, Understanding } from './types.js';

const KNOWN_PRIORITIES = new Set(['highest', 'high', 'medium', 'low', 'lowest']);
const ISSUE_TYPES = ['bug', 'story', 'task', 'epic'];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Rule-based reading of a request. Works offline; the LLM version below refines it. */
export function understandWithRules(request: string): Understanding {
  const fields: Record<string, HintedField> = {};
  const mentionedTool = request.match(/@([\w-]+)/)?.[1];
  const text = request.replace(/@[\w-]+/g, ' ').replace(/\s+/g, ' ').trim();

  const operation: Understanding['operation'] = /^\s*(create|log|raise|file|open|make|add|new)\b/i.test(text)
    ? 'create'
    : /\b(show|list|find|search|status)\b/i.test(text)
      ? 'read'
      : /\b(bug|story|task|ticket|issue)\b/i.test(text)
        ? 'create'
        : 'unknown';

  const type = ISSUE_TYPES.find((t) => new RegExp(`\\b${t}\\b`, 'i').test(text));
  if (type) fields.issuetype = { value: cap(type), confidence: 0.9 };

  const priority = text.match(/\b(highest|high|medium|low|lowest|urgent|critical|blocker)\b(?:\s+priority)?/i);
  if (priority) {
    const v = priority[1].toLowerCase();
    fields.priority = { value: cap(v), confidence: KNOWN_PRIORITIES.has(v) ? 0.9 : 0.5 };
  }

  const project = text.match(/\b(?:in|project)\s+(?:the\s+)?([A-Z][A-Z0-9]{1,9})\b/);
  if (project) fields.project = { value: project[1], confidence: 0.9 };

  const assignee = text.match(/\b[Aa]ssign(?:ed)?\s+(?:it\s+)?to\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (assignee) fields.assignee = { value: assignee[1], confidence: 0.8 };

  const team = text.match(/\b(\w+)\s+team\b/i);
  if (team && !/^(the|our|a|my)$/i.test(team[1])) fields.components = { value: cap(team[1].toLowerCase()), confidence: 0.7 };

  const summary = extractSummary(text);
  if (summary) fields.summary = { value: summary, confidence: 0.8 };

  return { operation, fields, mentionedTool };
}

function extractSummary(text: string): string {
  let s = text.replace(
    /^(?:please\s+)?(?:create|log|raise|file|open|make|add)\s+(?:a|an|new)?\s*(?:jira\s+)?(?:bug|story|task|epic)?\s*(?:ticket|issue)?\s*(?:for|about|on|:)?\s*/i,
    '',
  );
  s = s.split(',')[0];
  s = s
    .replace(/\b(highest|high|medium|low|lowest|urgent|critical|blocker)\s+priority\b/gi, '')
    .replace(/\bpriority\s+(highest|high|medium|low|lowest)\b/gi, '')
    .replace(/\b[Aa]ssign(?:ed)?\s+(?:it\s+)?to\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/g, '')
    .replace(/\b(?:in|project)\s+(?:the\s+)?[A-Z][A-Z0-9]{1,9}\b/g, '')
    .replace(/^\s*(?:for|about|on)\s+/i, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? cap(s) : '';
}

const SYSTEM = `Extract a Jira request as JSON: {"operation":"create"|"read"|"unknown","fields":{"issuetype":string?,"summary":string?,"priority":string?,"project":string?,"assignee":string?,"components":string?,"description":string?}}. Use only what the user wrote. Omit anything not stated. Never invent values.`;

/** Rules first, then the LLM if one is configured. Any LLM failure falls back to the rules. */
export async function understand(request: string, llm?: LlmGateway): Promise<Understanding> {
  const base = understandWithRules(request);
  if (!llm) return base;
  try {
    const raw = (await llm.extractJson({ system: SYSTEM, user: request })) as {
      operation?: string;
      fields?: Record<string, unknown>;
    };
    const fields = { ...base.fields };
    for (const [key, value] of Object.entries(raw.fields ?? {})) {
      if (typeof value !== 'string' || !value.trim()) continue;
      // Models often return lowercase text; a ticket title should start with a capital.
      const text = key === 'summary' ? cap(value.trim()) : value.trim();
      fields[key] = { value: text, confidence: 0.8 };
    }
    const operation = raw.operation === 'create' || raw.operation === 'read' ? raw.operation : base.operation;
    return { operation, fields, mentionedTool: base.mentionedTool };
  } catch {
    return base;
  }
}
