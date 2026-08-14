/* L9_META
 * layer: test
 * role: service_unit_test
 * status: active
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { post } }));
vi.mock('../../src/core/config.js', () => ({
  getConfig: () => ({ DATAFORSEO_LOGIN: 'login', DATAFORSEO_PASSWORD: 'pass' }),
}));

import { DataForSeoClient, normalizeSerpDatetime } from '../../src/services/dataforseo.js';

beforeEach(() => post.mockReset());

describe('DataForSeoClient.getOrganicSerp', () => {
  it('returns organic-only items with canonical domains and provider datetime', async () => {
    post.mockResolvedValue({
      data: {
        status_code: 20000,
        tasks: [{
          time: '0.3 sec',
          result: [{
            datetime: '2024-01-02 12:00:00 +00:00',
            item_types: ['organic', 'paid', 'people_also_ask'],
            items: [
              { type: 'paid', rank_absolute: 1, url: 'https://ad.example.com' },
              { type: 'organic', rank_group: 1, rank_absolute: 2, url: 'https://www.Alpha.com/x', title: 'A', description: 'da' },
              { type: 'people_also_ask', rank_absolute: 3 },
              { type: 'organic', rank_group: 2, rank_absolute: 5, url: 'https://beta.com/', title: 'B', description: 'db' },
            ],
          }],
        }],
      },
    });

    const client = new DataForSeoClient();
    const result = await client.getOrganicSerp({ keyword: 'metal roofing' });

    expect(result.items).toHaveLength(2); // paid + PAA excluded
    expect(result.items[0]).toMatchObject({ rankGroup: 1, domain: 'alpha.com', url: 'https://www.Alpha.com/x' });
    expect(result.items[1]).toMatchObject({ rankGroup: 2, domain: 'beta.com' });
    expect(result.observedAt).toBe('2024-01-02T12:00:00.000Z');
    expect(result.serpFeatures).toContain('paid');
  });

  it('surfaces DataForSEO API errors', async () => {
    post.mockResolvedValue({ data: { status_code: 40000, status_message: 'bad' } });
    await expect(new DataForSeoClient().getOrganicSerp({ keyword: 'x' })).rejects.toThrow(/DataForSEO error: bad/);
  });
});

describe('normalizeSerpDatetime', () => {
  it('normalizes DataForSEO datetime to ISO 8601', () => {
    expect(normalizeSerpDatetime('2024-01-02 12:00:00 +00:00')).toBe('2024-01-02T12:00:00.000Z');
  });
  it('returns undefined for empty/absent values', () => {
    expect(normalizeSerpDatetime(undefined)).toBeUndefined();
    expect(normalizeSerpDatetime('')).toBeUndefined();
  });
});
