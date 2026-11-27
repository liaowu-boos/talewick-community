import type { Version } from './types.ts';

interface VersionSearchResult {
  version: Version;
  number: number;
  match?: { chapterTitle: string; excerpt: string };
}

function bodyExcerpt(body: string, foldedOffset: number): string {
  const characters = Array.from(body);
  let offset = 0;
  let hit = 0;
  // Lowercasing can expand a character (for example İ), so map the folded
  // UTF-16 offset back to original code points before choosing the excerpt.
  while (hit < characters.length && offset + characters[hit].toLowerCase().length <= foldedOffset) {
    offset += characters[hit].toLowerCase().length;
    hit++;
  }
  const start = Math.max(0, Math.min(hit - 35, characters.length - 100));
  return characters.slice(start, start + 100).join('');
}

export function searchVersions(versions: Version[], query: string): VersionSearchResult[] {
  const search = query.trim().toLowerCase();
  const results: VersionSearchResult[] = [];
  for (let index = versions.length - 1; index >= 0; index--) {
    const version = versions[index];
    const row = { version, number: index + 1 };
    if (!search || version.label.toLowerCase().includes(search) ||
        (version.title ?? '').toLowerCase().includes(search)) {
      results.push(row);
      continue;
    }
    for (const chapter of version.chapters) {
      if (chapter.title.toLowerCase().includes(search)) {
        results.push({ ...row, match: { chapterTitle: chapter.title, excerpt: '' } });
        break;
      }
      const position = chapter.body.toLowerCase().indexOf(search);
      if (position >= 0) {
        results.push({ ...row, match: { chapterTitle: chapter.title, excerpt: bodyExcerpt(chapter.body, position) } });
        break;
      }
    }
  }
  return results;
}
