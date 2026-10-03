import { describe, expect, it } from 'vitest';
import { comparisonBody, firstPullDiff, mergeText, sameBody } from '../src/sync-text';
import { makeCheckpoint, planPull } from '../src/sync';

describe('whitespace-insensitive sync', () => {
  it('ignores blank lines, CRLF, and ordinary spacing without rewriting the local note', () => {
    const local = '\n# Title\r\n\r\nA   paragraph \r\n\r\n- Item\r\n';
    const remote = '# Title\nA paragraph\n- Item';
    expect(sameBody(local, remote)).toBe(true);
    expect(planPull(local, remote, null)).toMatchObject({ body: local, review: false });
    expect(comparisonBody(local)).toBe('# Title\nA paragraph\n- Item');
  });

  it('keeps local spacing when Notion only changes formatting whitespace', () => {
    const local = '# Title\n\nParagraph\n\n- Item\n';
    const remote = '# Title\nParagraph\n-  Item';
    expect(planPull(local, remote, makeCheckpoint(local, local, 'base'))).toMatchObject({ body: local, review: false });
  });

  it('merges real edits amid Notion blank-line removal while retaining local paragraph gaps', () => {
    const base = '# Title\n\nIntroduction\n\nFooter\n';
    const local = base.replace('Introduction', 'Local introduction');
    const remote = '# Title\nIntroduction\nRemote footer';
    expect(planPull(local, remote, makeCheckpoint(base, base, 'base'))).toMatchObject({
      review: false, body: '# Title\n\nLocal introduction\n\nRemote footer\n',
    });
    expect(mergeText(base, base, remote)).toMatchObject({ conflicts: false, body: '# Title\n\nIntroduction\n\nRemote footer\n' });
  });

  it('localizes first-pull review to actual edits rather than marking the whole note as conflicting', () => {
    const local = '# Title\n\nUnchanged paragraph\n\n- Local edit\n\nFooter';
    const remote = '# Title\nUnchanged paragraph\n- Remote edit\nFooter';
    const result = firstPullDiff(local, remote);
    expect(result).toMatch(/^# Title\n\nUnchanged paragraph/);
    expect(result.indexOf('<<<<<<< Obsidian')).toBeGreaterThan(result.indexOf('Unchanged paragraph'));
    expect(result).toContain('- Local edit');
    expect(result).toContain('- Remote edit');
    expect(result.match(/<<<<<<< Obsidian/g)).toHaveLength(1);
    expect(result).toMatch(/Footer$/);
  });

  it('ignores Notion autolink wrapping but not equivalent-looking examples inside code', () => {
    const url = 'https://github.com/cajames/obsidian-notion-sync';
    expect(sameBody(`Repo: ${url}`, `Repo: [${url}](${url})`)).toBe(true);
    expect(sameBody(`\`${url}\``, `\`[${url}](${url})\``)).toBe(false);
  });

  it('preserves significant whitespace in code, nesting, and hard line breaks', () => {
    expect(sameBody('```py\n  run()\n```', '```py\nrun()\n```')).toBe(false);
    expect(sameBody('```py\na\n\nb\n```', '```py\na\nb\n```')).toBe(false);
    expect(sameBody('`a  b`', '`a b`')).toBe(false);
    expect(sameBody('- Parent\n  - Child', '- Parent\n- Child')).toBe(false);
    expect(sameBody('First  \nSecond', 'First\nSecond')).toBe(false);
  });

  it('does not mask actual conflicting text edits', () => {
    const base = '# Title\n\nOriginal';
    const plan = planPull('# Title\n\nLocal edit', '# Title\nNotion edit', makeCheckpoint(base, base, 'base'));
    expect(plan.review).toBe(true);
    expect(plan.body).toContain('<<<<<<< Obsidian');
    expect(plan.body).toContain('Local edit');
    expect(plan.body).toContain('Notion edit');
  });
});
