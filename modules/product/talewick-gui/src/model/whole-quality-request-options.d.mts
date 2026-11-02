import type { Chapter, RevisionEvidencePolicy, WritingGoals } from './types';
export function readWritingGoals(value: unknown, chapters: Chapter[]): WritingGoals | undefined;
export function makeRevisionEvidencePolicy(): RevisionEvidencePolicy;
export function readRevisionEvidencePolicy(value: unknown): RevisionEvidencePolicy | undefined;
