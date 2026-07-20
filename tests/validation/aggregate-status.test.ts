import { describe, expect, it } from 'vitest';
import { aggregateStatus, exitCodeForStatus, isProfilePassing, type ProfileDefinition } from '../../scripts/validation/types.js';

const strict: ProfileDefinition = { gates: ['test'], allow_pass_with_findings: false, blocked_is_failure: true };
const tolerant: ProfileDefinition = { gates: ['test'], allow_pass_with_findings: true, blocked_is_failure: true };
const externallyTolerant: ProfileDefinition = { gates: ['test'], allow_pass_with_findings: true, blocked_is_failure: false };

describe('aggregateStatus', () => {
  it('returns UNKNOWN for no statuses', () => expect(aggregateStatus([])).toBe('UNKNOWN'));
  it('returns PASS when all gates pass', () => expect(aggregateStatus(['PASS', 'PASS'])).toBe('PASS'));
  it('promotes non-blocking findings', () => expect(aggregateStatus(['PASS', 'PASS_WITH_FINDINGS'])).toBe('PASS_WITH_FINDINGS'));
  it('preserves BLOCKED over findings', () => expect(aggregateStatus(['PASS_WITH_FINDINGS', 'BLOCKED'])).toBe('BLOCKED'));
  it('preserves UNKNOWN over BLOCKED', () => expect(aggregateStatus(['BLOCKED', 'UNKNOWN'])).toBe('UNKNOWN'));
  it('preserves FAIL over every other state', () => expect(aggregateStatus(['PASS', 'UNKNOWN', 'FAIL'])).toBe('FAIL'));
  it('applies profile finding policy', () => {
    expect(isProfilePassing('PASS_WITH_FINDINGS', strict)).toBe(false);
    expect(isProfilePassing('PASS_WITH_FINDINGS', tolerant)).toBe(true);
  });
  it('applies the profile blocked policy', () => {
    expect(isProfilePassing('BLOCKED', strict)).toBe(false);
    expect(isProfilePassing('BLOCKED', externallyTolerant)).toBe(true);
  });
  it('maps blocking statuses to stable process codes', () => {
    expect(exitCodeForStatus('FAIL')).toBe(1);
    expect(exitCodeForStatus('BLOCKED')).toBe(2);
    expect(exitCodeForStatus('UNKNOWN')).toBe(3);
  });
});
