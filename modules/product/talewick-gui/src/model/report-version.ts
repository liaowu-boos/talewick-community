import type { IsolatedHistoryRecord } from './independent-review.ts';
import { manuscriptRevision } from './runtime.ts';
import type { Version } from './types.ts';

/** Locate candidate snapshots. Opening one still requires the server's full manuscript SHA check. */
export function findReportVersions(versions: Version[], reports: IsolatedHistoryRecord[]): Map<string, Version> {
  const byTitle = new Map<string, Map<string, string[]>>();
  const matches = new Map<string, Version>();
  for (const report of reports) {
    if (typeof report.title !== 'string') continue;
    const revisions = byTitle.get(report.title) ?? new Map<string, string[]>();
    const ids = revisions.get(report.manuscriptRevision) ?? [];
    ids.push(report.id);
    revisions.set(report.manuscriptRevision, ids);
    byTitle.set(report.title, revisions);
  }

  for (const version of versions) {
    if (!version || !Array.isArray(version.chapters) || !version.chapters.length) continue;
    if (version.title !== undefined && !byTitle.has(version.title)) continue;
    const ids = new Set<string>();
    const valid = version.chapters.every(chapter => {
      if (!chapter || typeof chapter.id !== 'string' || !chapter.id || typeof chapter.title !== 'string' ||
          typeof chapter.body !== 'string' || ids.has(chapter.id)) return false;
      ids.add(chapter.id);
      return true;
    });
    if (!valid) continue;
    // Legacy snapshots have no title. Try each registered title once, including when
    // several reports on different dates refer to exactly the same manuscript.
    const titles = version.title === undefined ? byTitle.keys() : [version.title];
    for (const title of titles) {
      const revision = manuscriptRevision({title, chapters: version.chapters});
      for (const reportId of byTitle.get(title)?.get(revision) ?? []) {
        matches.set(reportId, version); // Later equivalent snapshots take precedence.
      }
    }
  }
  return matches;
}
