import { describe, expect, it } from 'vitest';
import type { PublicPlan } from './api';
import { annualLine, level, monthsFreeYearly, storageAmount } from './components/Plan';
import { allowanceBytes } from './format';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const plan = (price: number | null) => ({ price }) as PublicPlan;

describe('plan allowances on screen', () => {
  it('shows storage in the same binary units the server enforces, never rounding 250 MB away', () => {
    expect(allowanceBytes(250 * MB)).toBe('250 MB');
    expect(allowanceBytes(5 * GB)).toBe('5 GB');
    expect(allowanceBytes(25 * GB)).toBe('25 GB');
    expect(allowanceBytes(1024 * GB)).toBe('1 TB');
    expect(storageAmount(212.4 * MB)).toBe('212.4 MB');
    expect(storageAmount(2048)).toBe('2.0 KB');
  });

  it('spells out the yearly charge', () => {
    expect(monthsFreeYearly(10 / 12)).toBe(2);
    expect(annualLine(plan(10), 10 / 12)).toBe('$100 billed yearly — 2 months free');
    expect(annualLine(plan(25), 10 / 12)).toBe('$250 billed yearly — 2 months free');
    expect(annualLine(plan(60), 10 / 12)).toBe('$600 billed yearly — 2 months free');
    expect(annualLine(plan(0), 10 / 12)).toBeNull();
    expect(annualLine(plan(10), 1)).toBe('$120 billed yearly');
  });

  it('warns from 80% and calls it full at the limit', () => {
    expect(level(199 * MB, 250 * MB)).toBe('ok');
    expect(level(200 * MB, 250 * MB)).toBe('near');
    expect(level(250 * MB, 250 * MB)).toBe('full');
    expect(level(5, null)).toBe('ok');
  });
});
