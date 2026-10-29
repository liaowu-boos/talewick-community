/** Workspace state. ISO dates are strings so saved projects remain JSON-safe. */
export type Mode = 'auto' | 'light' | 'pro';
export type Page = 'create' | 'publication-feedback' | 'library' | 'styles' | 'settings' | 'account';
export type Phase = 'direction' | 'premise' | 'turn' | 'opening' | 'complete' | 'revision' | 'done';
export type ProjectStatus = 'draft' | 'writing' | 'ready';
export type DocMode = 'read' | 'edit' | 'review';
export type CompareMode = 'after' | 'diff' | 'before';
export type GenerationKind = 'opening' | 'full';
export type InspirationKey = 'character' | 'world' | 'plot' | 'theme';
export type InspirationContext = Record<InspirationKey, string>;

export interface Chapter { id: string; title: string; body: string }
export interface Version { id: string; label: string; date: string; title?: string; chapters: Chapter[] }
export interface ImportedBaseline {
  provenance: 'whole_revision_source';
  sourceTaskId: string;
  sourceRequestId: string;
  title: string;
  baseRevision: string;
  sourceManuscriptSha256: string;
  qualityCheckStatus: 'incomplete';
}
/** UTF-16 offset, matching textarea selectionStart and string.slice. */
export interface QuoteSource { chapterId: string; start: number }
export interface WritingGoalProblem {
  problemId: string;
  statement: string;
  searchTerms: string[];
  requiredTermGroups: string[][];
  context: Record<string, unknown>;
}
export interface WritingGoal {
  id: string;
  dimension: 'psychology' | 'emotion' | 'choice';
  problem: WritingGoalProblem;
  chapterIds: string[];
  preservationBoundaries: string[];
}
export interface WritingGoals {
  schemaVersion: 'creation-writing-goals-1';
  goals: WritingGoal[];
}
export interface PendingEdit {
  id: string;
  chapterId: string;
  before: string;
  start?: number;
  after: string;
  reason: string;
  status: 'pending' | 'accepted' | 'rejected';
  /** Runtime proposals require an exact source chapter, unlike legacy text selections. */
  taskId?: string;
  beforeTitle?: string;
  afterTitle?: string;
}
export interface Message {
  id?: string;
  role: 'user' | 'assistant';
  text: string;
  quote?: string;
  artifact?: boolean;
  date?: string;
  turnId?: string;
  turnStatus?: ConversationTurnStatus;
  turnError?: string;
  connectionError?: string;
  taskId?: string;
}
export type ConversationTurnStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface ConversationTurn {
  id: string;
  projectId: string;
  userText: string;
  assistantText: string;
  status: ConversationTurnStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  task?: { request: RuntimeRequest; task: RuntimeTask };
}
export interface ConversationSubmission {
  turnId: string;
  text: string;
  mode?: Mode;
  snapshot: RuntimeRequest;
  history?: { role: 'user' | 'assistant'; text: string }[];
  allowTools: boolean;
}
export interface Attachment { id?: string; name: string; content: string; size?: number; type?: string }

export interface Project {
  id: string;
  title: string;
  idea: string;
  mode: Mode;
  phase: Phase;
  status: ProjectStatus;
  messages: Message[];
  chapters: Chapter[];
  versions: Version[];
  pendingEdits: PendingEdit[];
  docOpen: boolean;
  docClosedByUser: boolean;
  docExpanded: boolean;
  docMode: DocMode;
  compare: CompareMode;
  selectedChapter: number;
  updatedAt: string;
  context: InspirationContext;
  libraryIds: string[];
  styleId: string | null;
  attachments: Attachment[];
  draftInput: string;
  direction?: string;
  extraIdeas?: string[];
  paused?: boolean;
  generationKind?: GenerationKind;
  beforeGenerationPhase?: Phase;
  docUpdated?: boolean;
  /** Baseline before direct editing; used for undo without creating a version per keystroke. */
  editorBaseline?: Chapter[] | null;
  editorVersionId?: string | null;
  editorVersionCompare?: boolean;
  runtime?: RuntimeBinding;
  runtimeHistory?: RuntimeTask[];
  importedBaseline?: ImportedBaseline;
}

export type RuntimeEngine = 'ai-sdk' | 'fixed';
export interface RuntimeInfo {
  configured: boolean;
  provider: string;
  model: string;
  ready: boolean;
  message: string;
  engine: RuntimeEngine;
  engineVersion: string;
  engineLabel: string;
}
export type RuntimeTaskStatus = 'queued' | 'running' | 'needs_input' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type RuntimeFailureKind = 'review_output' | 'delivery_check' | 'network' | 'configuration' | 'writing' | 'unknown' | 'interrupted' | 'cancelled';
export type RuntimeRetryScope = 'unfinished_review' | 'unfinished_check' | 'unfinished_writing' | 'unfinished_step';
export interface RuntimeTaskFailure {
  kind: RuntimeFailureKind;
  phase: 'writing' | 'review' | 'check' | 'step';
  retryScope: RuntimeRetryScope;
  message: string;
  recoverable?: boolean;
}
export interface RuntimeRequest {
  projectTitle?: string;
  projectId: string;
  requestId: string;
  kind: 'create' | 'revise';
  revisionMode?: 'whole-manuscript-v1' | 'whole-manuscript-v2';
  idea: string;
  context: InspirationContext;
  materials: { id: string; title: string; content: string }[];
  style: Pick<StyleProfile, 'name' | 'description' | 'rules' | 'traits'> | null;
  chapters: Chapter[];
  instruction: string;
  quote: string;
  quoteSource?: QuoteSource;
  writingGoals?: WritingGoals;
  baseRevision: string;
}
/** Public action summaries supplied by the runtime, never private model reasoning. */
export interface AgentDecisionTrace {
  phase: 'plan' | 'review';
  action: string;
  reason: string;
  evidence?: string[];
  targetChapterIds?: string[];
  round?: number;
  manuscriptSha256?: string;
  toolCallId?: string;
}
export interface ReadingObservation {
  id: string;
  observation: string;
  category: string;
  suspectedCause: string;
  evidence: { chapterId: string; quote: string; evidenceVerified: boolean }[];
  evidenceVerified: boolean;
  crossScene: boolean;
  revisionScope: { chapterIds: string[]; action: string; reason: string; preserve: string[]; scopeVerified: boolean };
  status: 'proposed' | 'needs_evidence';
  interpretationStatus: 'model_hypothesis';
  automaticRevisionAuthorized: false;
  unresolved: true;
  limitations: string[];
}
export interface RuntimeReview {
  summary: string;
  issues?: unknown[];
  limitations?: unknown[];
  readingObservations?: ReadingObservation[];
  readingObservationsInvalid?: boolean;
  strengths?: string[];
  readerType?: string;
  readScope?: string;
  phase?: string;
  manuscriptSha256?: string;
}
export interface RuntimeResult {
  title: string;
  chapters: Chapter[];
  baseRevision?: string;
  revisionApplied?: boolean;
  qualityCheckStatus?: 'incomplete';
  review: RuntimeReview;
  /** Exact server review, retained before view normalization for fingerprint checks. */
  reviewOriginal?: Record<string, unknown>;
  /** Kept verbatim, including unsupported records, for historical inspection. */
  reviewAdjudication?: unknown;
  adjudicationHistory?: unknown[];
  reviewAdjudicationBinding?: {
    status: 'missing' | 'invalid' | 'unsupported' | 'unverified' | 'stale' | 'bound';
    diagnostics: string[];
    manuscriptSha256: string;
    adjudicationSha256?: string;
  };
  checks: Record<string, unknown>;
  knowledge: Record<string, unknown>;
  activeKnowledge?: Record<string, unknown>;
  /** Optional public ledger; older results have no follow-up record. */
  followupRetrieval?: Record<string, unknown>;
  followupRetrievalInvalid?: boolean;
  deepReference?: Record<string, unknown>;
  warnings: string[];
  agentTrace?: AgentDecisionTrace[];
  /** Creation owns the internal schema; product preserves and presents its public fields. */
  wholeRevision?: Record<string, unknown>;
}
export interface PartialDraft {
  status: 'unreviewed_partial';
  chapters: Chapter[];
  availableChapterCount: number;
  expectedChapterCount: number;
}
export interface RuntimeTask {
  id: string;
  projectId: string;
  requestId: string;
  kind: 'create' | 'revise';
  revisionMode?: 'whole-manuscript-v1' | 'whole-manuscript-v2';
  status: RuntimeTaskStatus;
  stage: string;
  createdAt: string;
  updatedAt: string;
  baseRevision: string;
  /** Bound by the server when creating the task; legacy records load as fixed. */
  engine: RuntimeEngine;
  engineVersion: string;
  error?: string;
  failure?: RuntimeTaskFailure;
  question?: string;
  result?: RuntimeResult;
  partialDraft?: PartialDraft;
}
export interface RuntimeBinding {
  request: RuntimeRequest;
  /** Exact source snapshot is the final guard against overwriting later edits. */
  baseManuscript: { title: string; chapters: Chapter[] };
  task?: RuntimeTask;
  submitting?: boolean;
  connectionError?: string;
  handledTaskId?: string;
  resultDisposition?: 'applied' | 'partially-applied' | 'proposals' | 'held' | 'whole-revision-candidate' | 'whole-quality-groups' | 'declined';
  qualityAdoption?: {
    selectedGroupIds: string[];
    declinedGroupIds: string[];
    fullCandidateRereadInherited: boolean;
    rereadScope: 'full-candidate' | 'selected-groups-unchecked';
  };
  candidateRecheckSelection?: { id: string; sourceTaskId: string; candidateSha256: string; checkerVersion: string; selectedAt: string };
  message?: string;
}

export interface LibraryItem {
  id: string;
  title: string;
  type: '小说' | '素材' | '设定';
  content: string;
  chars: number;
  status: 'ready' | 'processing' | 'error';
  date: string;
  tags: string[];
  error?: string;
  fileName?: string;
}
export interface StyleProfile {
  id: string;
  name: string;
  description: string;
  sourceIds: string[];
  traits: string[];
  rules: string;
  active: boolean;
  date: string;
}
export interface Settings { reduceMotion: boolean; fontSize: number; autoSave: boolean }
export interface Account { name: string; email: string; signedIn: boolean; avatar?: string }
export interface AppState {
  schemaVersion: 1;
  page: Page;
  activeProjectId: string | null;
  projects: Project[];
  library: LibraryItem[];
  styles: StyleProfile[];
  settings: Settings;
  account: Account;
  homeIdea: string;
  homeMode: Mode;
  context: InspirationContext;
  quote: string;
  quoteSource?: QuoteSource;
  selectedLibrary: string[];
  selectedStyle: string | null;
  attachments: Attachment[];
}

export interface StoryDirection { id: string; title: string; description: string; tag: string }
export interface SaveResult { ok: boolean; error?: string }
export interface EditResult { accepted: number; skipped: number }
export type FlowResult =
  | { kind: 'generation'; generationKind: GenerationKind }
  | { kind: 'advanced'; phase: Phase }
  | { kind: 'blocked'; reason: string }
  | { kind: 'done' };
