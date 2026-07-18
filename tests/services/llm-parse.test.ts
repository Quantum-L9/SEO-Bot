import { describe, it, expect } from 'vitest';
import { parseJsonFromLlm, parseScore } from '../../src/services/llm-parse.js';

describe('parseJsonFromLlm', () => {
  it('parses plain JSON', () => {
    expect(parseJsonFromLlm<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    expect(parseJsonFromLlm('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonFromLlm('```\n[1,2,3]\n```')).toEqual([1, 2, 3]);
  });

  it('recovers JSON embedded in a prose preamble/suffix', () => {
    expect(parseJsonFromLlm('Sure! Here you go: {"ok":true} — hope that helps')).toEqual({ ok: true });
  });

  it('extracts the FIRST balanced JSON value when multiple blocks are present', () => {
    // A greedy first-open-to-last-close match would capture `{"a":1} ... {"b":2}`
    // and fail to parse; the balanced scan returns just the first value.
    expect(parseJsonFromLlm('{"a":1} and then {"b":2}')).toEqual({ a: 1 });
    expect(parseJsonFromLlm('[1,2] then [3,4]')).toEqual([1, 2]);
  });

  it('is not fooled by brackets inside string values', () => {
    expect(parseJsonFromLlm('{"note":"a } b ] c"} trailing')).toEqual({ note: 'a } b ] c' });
  });

  it('throws a clear error (never a raw SyntaxError) on non-JSON', () => {
    expect(() => parseJsonFromLlm('I could not complete that request.')).toThrow(/did not return valid JSON/);
  });

  it('does not echo raw model output in the error message', () => {
    const secret = 'client PII: john@example.com ssn 123-45-6789';
    try {
      parseJsonFromLlm(secret);
      throw new Error('expected parseJsonFromLlm to throw');
    } catch (e: any) {
      expect(e.message).not.toContain('john@example.com');
      expect(e.message).not.toContain('123-45-6789');
    }
  });
});

describe('parseScore', () => {
  it('parses a numeric reply', () => {
    expect(parseScore('87')).toBe(87);
    expect(parseScore('  42.5  ')).toBe(42.5);
  });

  it('clamps to 0–100', () => {
    expect(parseScore('150')).toBe(100);
    expect(parseScore('-10')).toBe(0);
  });

  it('throws on a non-numeric reply instead of returning NaN', () => {
    expect(() => parseScore('high')).toThrow(/numeric score/);
    expect(() => parseScore('')).toThrow(/numeric score/);
  });
});
