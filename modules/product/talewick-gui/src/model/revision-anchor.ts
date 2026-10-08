import type { PendingEdit } from './types';

/** An explicit UTF-16 anchor never falls back to another occurrence of the same text. */
export function getEditStart(body: string, edit: Pick<PendingEdit, 'before' | 'start'>): number {
  if (!edit.before) return -1;
  if (edit.start !== undefined) {
    if (!Number.isSafeInteger(edit.start) || edit.start < 0) return -1;
    return body.slice(edit.start, edit.start + edit.before.length) === edit.before ? edit.start : -1;
  }
  // Legacy proposals remain readable, but an ambiguous old quote requires reselection.
  const first = body.indexOf(edit.before);
  return first >= 0 && body.indexOf(edit.before, first + 1) < 0 ? first : -1;
}
