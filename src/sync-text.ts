import { diff3Merge, diffIndices, mergeDiff3 } from 'node-diff3';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit } from 'unist-util-visit';

export function comparisonLines(body: string) {
  const source = body.replace(/\r\n/g, '\n');
  const ranges: { start: number; end: number; block: boolean }[] = [];
  visit(fromMarkdown(source), ['code', 'inlineCode'], (node) => {
    if (node.position?.start.offset !== undefined && node.position.end.offset !== undefined) {
      ranges.push({ start: node.position.start.offset, end: node.position.end.offset, block: node.type === 'code' });
    }
  });
  const units: { key: string; content: string; prefix: string; start: number; end: number }[] = [];
  let offset = 0;
  let pending = '';
  for (const line of source.split('\n')) {
    const protectedRanges = ranges.filter((range) => range.start <= offset + line.length && range.end > offset);
    const block = protectedRanges.some((range) => range.block);
    if (!line.trim() && !protectedRanges.length) {
      pending += line + '\n';
      offset += line.length + 1;
      continue;
    }
    let key = line;
    if (!block) {
      const literals: string[] = [];
      for (const range of [...protectedRanges].reverse()) {
        const start = Math.max(0, range.start - offset);
        const end = Math.min(line.length, range.end - offset);
        const token = `\u0000${literals.length}\u0000`;
        literals.push(line.slice(start, end));
        key = key.slice(0, start) + token + key.slice(end);
      }
      const nesting = line.match(/^[ \t]+(?=(?:[-+*]|\d+[.)])\s)/)?.[0] ?? '';
      key = key.replace(/[ \t]+/g, ' ').trim()
        // Notion serializes bare URLs as links; this wrapper is not a text edit.
        .replace(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, '$1')
        .replace(/\u0000(\d+)\u0000/g, (_, index: string) => literals[Number(index)]);
      if (nesting) key = nesting.replace(/\t/g, '    ') + key;
      if (/ {2,}$/.test(line) && source.slice(offset + line.length + 1).split('\n')[0]?.trim()) key += '  ';
    }
    units.push({ key, content: line, prefix: pending, start: offset - pending.length, end: offset + line.length });
    pending = '';
    offset += line.length + 1;
  }
  return { source, units, tail: pending };
}

export function comparisonBody(body: string) {
  return comparisonLines(body).units.map((unit) => unit.key).join('\n');
}

export function sameBody(a: string, b: string) {
  return comparisonBody(a) === comparisonBody(b);
}

function alignedUnits(units: ReturnType<typeof comparisonLines>['units'], target: string[]) {
  const result = new Map<number, (typeof units)[number]>();
  let from = 0;
  let to = 0;
  for (const change of diffIndices(units.map((unit) => unit.key), target)) {
    while (from < change.buffer1[0]) result.set(to++, units[from++]);
    from = change.buffer1[0] + change.buffer1[1];
    to = change.buffer2[0] + change.buffer2[1];
  }
  while (from < units.length) result.set(to++, units[from++]);
  return result;
}

export function mergeText(local: string, base: string, remote: string, proposeRemote = false) {
  const a = comparisonLines(local);
  const o = comparisonLines(base);
  const b = comparisonLines(remote);
  const keys = (value: typeof a) => value.units.map((unit) => unit.key);
  // A stable virtual boundary stops diff3 treating edits to adjacent passages
  // as overlapping merely because Notion removed their blank separator lines.
  let boundary = '\u0001';
  while ([...keys(a), ...keys(o), ...keys(b)].includes(boundary)) boundary += '\u0001';
  const separated = (value: typeof a) => keys(value).flatMap((key, index) => index ? [boundary, key] : [key]);
  const merged = mergeDiff3(separated(a), separated(o), separated(b), { label: { a: 'Obsidian', o: 'Last synced', b: 'Notion' } });
  // A review proposal takes the remote side only inside conflicts. Independent
  // local edits stay intact; the editor requires explicit decisions before save.
  const proposed = proposeRemote
    ? diff3Merge(separated(a), separated(o), separated(b), {}).flatMap((section) => section.ok ?? section.conflict!.b)
    : merged.result;
  const result = proposed.filter((key) => key !== boundary);
  const localUnits = alignedUnits(a.units, result);
  const remoteUnits = alignedUnits(b.units, result);
  const baseUnits = alignedUnits(o.units, result);
  const prefixes = new Map<number, string>();
  for (const change of diffIndices(keys(a), result)) {
    if (change.buffer1[1] && change.buffer2[1]) prefixes.set(change.buffer2[0], a.units[change.buffer1[0]].prefix);
  }
  const body = result.map((key, index) => {
    const unit = localUnits.get(index) ?? remoteUnits.get(index) ?? baseUnits.get(index);
    return (prefixes.get(index) ?? unit?.prefix ?? '') + (unit?.content ?? key);
  }).join('\n') + a.tail;
  return { body, conflicts: merged.conflict };
}

export function firstPullDiff(local: string, remote: string) {
  const a = comparisonLines(local);
  const b = comparisonLines(remote);
  let output = '';
  let previous = 0;
  for (const change of diffIndices(a.units.map((unit) => unit.key), b.units.map((unit) => unit.key))) {
    const start = a.units[change.buffer1[0]]?.start ?? a.source.length;
    const end = change.buffer1[1] ? a.units[change.buffer1[0] + change.buffer1[1] - 1].end : start;
    const remotePart = b.units.slice(change.buffer2[0], change.buffer2[0] + change.buffer2[1])
      .map((unit) => unit.prefix + unit.content).join('\n');
    output += a.source.slice(previous, start);
    if (output && !output.endsWith('\n')) output += '\n';
    output += ['<<<<<<< Obsidian', a.source.slice(start, end), '=======', remotePart, '>>>>>>> Notion'].join('\n');
    if (start === end && start < a.source.length) output += '\n';
    previous = end;
  }
  return output + a.source.slice(previous);
}
