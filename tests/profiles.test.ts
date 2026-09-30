import { describe, expect, it } from 'vitest';
import { resolveProfile } from '../profiles';

const profiles = [
  { name: 'Personal', token: 'personal-token', parentId: 'personal-page' },
  { name: 'Work', token: 'work-token', parentId: 'work-page' },
];

describe('profile resolution', () => {
  it('uses the first profile by default', () => {
    expect(resolveProfile(profiles, null)).toBe(profiles[0]);
  });

  it('selects an explicit profile with its token and parent', () => {
    expect(resolveProfile(profiles, 'Work')).toBe(profiles[1]);
  });

  it('matches names case-insensitively', () => {
    expect(resolveProfile(profiles, 'work')).toBe(profiles[1]);
    expect(resolveProfile(profiles, '  WORK  ')).toBe(profiles[1]);
  });

  it('fails with the missing name instead of falling back', () => {
    expect(() => resolveProfile(profiles, 'Other')).toThrow('Notion workspace "Other" has no matching profile');
  });

  it('rejects ambiguous names and missing default', () => {
    expect(() => resolveProfile([...profiles, { ...profiles[1], name: 'work' }], 'Work')).toThrow('Multiple profiles');
    expect(() => resolveProfile([], null)).toThrow('Add a workspace profile');
  });
});
