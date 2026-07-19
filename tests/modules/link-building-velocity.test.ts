import { describe, it, expect } from 'vitest';
import { velocityRunLimit } from '../../src/modules/link-building/velocity.js';

// SAFETY defaults in link-building: maxLinksPerWeek=5, maxEmailsPerDay=10.
describe('velocityRunLimit', () => {
  it('is capped by the weekly remainder, not the daily cap', () => {
    // Nothing sent yet this week → 5 weekly headroom < 10 daily cap → 5.
    expect(velocityRunLimit(0, 5, 10)).toBe(5);
  });

  it('shrinks as the week fills up', () => {
    expect(velocityRunLimit(3, 5, 10)).toBe(2);
    expect(velocityRunLimit(5, 5, 10)).toBe(0);
    expect(velocityRunLimit(9, 5, 10)).toBe(0); // never negative
  });

  it('is capped by the daily cap when weekly headroom is larger', () => {
    expect(velocityRunLimit(0, 100, 10)).toBe(10);
  });
});
