import { fromMarkdown } from 'mdast-util-from-markdown';
import { visit } from 'unist-util-visit';

// Use Markdown syntax rather than regexes to recognize all forms of code literals.
export function codeRanges(body: string) {
  const ranges: { start: number; end: number }[] = [];
  visit(fromMarkdown(body), ['code', 'inlineCode'], (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
  });
  return ranges;
}
