export type JsonSchema = Record<string, any>;

export interface Candidate {
  id: string;
  label: string;
  detail?: string;
}

/** A real value for a field: `id` is what the tool receives, `label` is what the user sees. */
export interface FieldValue {
  id: string;
  label: string;
  assumed?: boolean;
}
export type Fields = Record<string, FieldValue>;

export interface PlanStep {
  connectionId: string;
  op: 'create';
  params: Record<string, string>;
}

export type ExecResult =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string; retryable: boolean };

export interface Question {
  id: string;
  /** 1 tool, 3 missing required, 4 ambiguous name, 5 invalid value, 6 low confidence */
  source: 1 | 3 | 4 | 5 | 6;
  blocking: boolean;
  field: string;
  text: string;
  choices: Candidate[];
  allowFreeText: true;
}

export interface CardRow {
  field: string;
  title: string;
  value: string;
  assumed: boolean;
}

export interface ConfirmationCard {
  title: string;
  connectionName: string;
  rows: CardRow[];
  warnings: string[];
}

export interface HintedField {
  value: string;
  confidence: number;
}

export interface Understanding {
  operation: 'create' | 'read' | 'unknown';
  fields: Record<string, HintedField>;
  mentionedTool?: string;
}
