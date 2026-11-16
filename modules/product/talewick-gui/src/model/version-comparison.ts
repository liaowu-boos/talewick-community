import type { Chapter } from './types.ts';

interface Manuscript {
  title?: string;
  chapters: Chapter[];
}

interface ChapterDifference {
  id: string;
  before?: Chapter;
  after?: Chapter;
  beforeIndex: number;
  afterIndex: number;
  moved: boolean;
}

export function compareManuscripts(before: Manuscript, after: Manuscript) {
  const titleStatus = before.title === undefined || after.title === undefined ? 'unknown'
    : before.title === after.title ? 'same' : 'changed';
  const chapters: ChapterDifference[] = [];
  const originalPositions = new Map(before.chapters.map((chapter, index) => [chapter.id, index]));
  const retained = new Set<string>();
  const movedIds = new Set<string>();

  // In the new order, a shared chapter moves relative to another if a larger
  // original index precedes it, or a smaller original index follows it.
  let smallestLater = before.chapters.length;
  for (let index = after.chapters.length - 1; index >= 0; index--) {
    const { id } = after.chapters[index];
    const position = originalPositions.get(id);
    if (position === undefined) continue;
    retained.add(id);
    if (position > smallestLater) movedIds.add(id);
    smallestLater = Math.min(smallestLater, position);
  }

  // Show additions, edits and moves in new order, then removals in original order.
  let largestEarlier = -1;
  for (const [afterIndex, chapter] of after.chapters.entries()) {
    const beforeIndex = originalPositions.get(chapter.id);
    if (beforeIndex === undefined) {
      chapters.push({ id: chapter.id, after: chapter, beforeIndex: -1, afterIndex, moved: false });
      continue;
    }
    if (beforeIndex < largestEarlier) movedIds.add(chapter.id);
    largestEarlier = Math.max(largestEarlier, beforeIndex);
    const original = before.chapters[beforeIndex];
    const moved = movedIds.has(chapter.id);
    if (moved || original.title !== chapter.title || original.body !== chapter.body) {
      chapters.push({ id: chapter.id, before: original, after: chapter, beforeIndex, afterIndex, moved });
    }
  }
  for (const [beforeIndex, chapter] of before.chapters.entries()) {
    if (!retained.has(chapter.id)) {
      chapters.push({ id: chapter.id, before: chapter, beforeIndex, afterIndex: -1, moved: false });
    }
  }
  return { titleStatus, orderChanged: movedIds.size > 0, chapters } as const;
}
