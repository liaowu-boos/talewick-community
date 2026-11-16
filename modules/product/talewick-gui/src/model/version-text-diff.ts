export interface VersionTextChange {
  kind: 'equal' | 'delete' | 'insert';
  text: string;
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
const maxEditDistance = 128;

function append(parts: VersionTextChange[], kind: VersionTextChange['kind'], text: string) {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.kind === kind) last.text += text;
  else parts.push({kind, text});
}

// Bounded Myers diff. Each frontier holds the furthest reachable offset on each
// diagonal. A wholesale rewrite can be displayed as one replacement in linear space.
function middleDiff(before: string[], after: string[]): VersionTextChange[] {
  if (before.length && after.length && Math.abs(before.length - after.length) <= maxEditDistance) {
    const trace: Map<number, number>[] = [];
    let previous = new Map([[1, 0]]);
    for (let depth = 0; depth <= maxEditDistance; depth++) {
      const next = new Map<number, number>();
      trace.push(previous);
      for (let k = -depth; k <= depth; k += 2) {
        const down = previous.get(k + 1) ?? -Infinity;
        const right = previous.get(k - 1) ?? -Infinity;
        let x = right < down ? down : right + 1;
        let y = x - k;
        while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; }
        next.set(k, x);
        if (x === before.length && y === after.length) {
          const reverse: VersionTextChange[] = [];
          for (let d = depth; d > 0; d--) {
            const diagonal = x - y;
            const frontier = trace[d];
            const inserted = (frontier.get(diagonal - 1) ?? -Infinity) < (frontier.get(diagonal + 1) ?? -Infinity);
            const prevK = inserted ? diagonal + 1 : diagonal - 1;
            const prevX = frontier.get(prevK)!;
            const prevY = prevX - prevK;
            append(reverse, 'equal', before.slice(prevX + (inserted ? 0 : 1), x).join(''));
            // Keep individual edits until reversal so consecutive inserts retain their order.
            reverse.push(inserted ? {kind: 'insert', text: after[prevY]} : {kind: 'delete', text: before[prevX]});
            x = prevX;
            y = prevY;
          }
          append(reverse, 'equal', before.slice(0, x).join(''));
          return reverse.reverse();
        }
      }
      previous = next;
    }
  }
  return [{kind: 'delete', text: before.join('')}, {kind: 'insert', text: after.join('')}];
}

function diffTokens(before: string[], after: string[]): VersionTextChange[] {
  const limit = Math.min(before.length, after.length);
  let start = 0, end = 0;
  while (start < limit && before[start] === after[start]) start++;
  while (end < limit - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const parts: VersionTextChange[] = [];
  append(parts, 'equal', before.slice(0, start).join(''));
  for (const part of middleDiff(before.slice(start, before.length - end), after.slice(start, after.length - end))) {
    append(parts, part.kind, part.text);
  }
  append(parts, 'equal', before.slice(before.length - end).join(''));
  return parts;
}

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), item => item.segment) : Array.from(text);
}

export function diffVersionText(before: string, after: string): VersionTextChange[] {
  if (before === after) return before ? [{kind: 'equal', text: before}] : [];
  if (!before || !after) return [{kind: before ? 'delete' : 'insert', text: before || after}];
  const lines = (text: string) => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const parts: VersionTextChange[] = [];
  let removed = '', added = '';
  function flush() {
    if (removed && added) {
      for (const part of diffTokens(graphemes(removed), graphemes(added))) append(parts, part.kind, part.text);
    } else {
      append(parts, 'delete', removed);
      append(parts, 'insert', added);
    }
    removed = '';
    added = '';
  }
  for (const part of diffTokens(lines(before), lines(after))) {
    if (part.kind === 'delete') removed += part.text;
    else if (part.kind === 'insert') added += part.text;
    else {
      flush();
      append(parts, 'equal', part.text);
    }
  }
  flush();
  return parts;
}
