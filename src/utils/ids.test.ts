import { test, expect, describe } from 'bun:test';
import { generateRunId } from './ids';

describe('generateRunId', () => {
  test('returns a string', () => {
    expect(typeof generateRunId('specs/onboarding.md')).toBe('string');
  });
  test('derives slug from filename', () => {
    const id = generateRunId('specs/my-feature.md');
    expect(id.startsWith('my-feature-')).toBe(true);
  });
  test('two calls produce different IDs', () => {
    const a = generateRunId('specs/test.md');
    const b = generateRunId('specs/test.md');
    expect(a).not.toBe(b);
  });
  test('handles special chars in filename', () => {
    const id = generateRunId('specs/My Feature!! v2.md');
    expect(id.startsWith('my-feature-v2-')).toBe(true);
  });
});
