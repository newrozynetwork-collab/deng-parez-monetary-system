const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../services/calculator');

test('calculator: basic 60/40 split with no referrals', () => {
  const r = calculate({
    grossRevenue: 1000,
    bankFeePct: 2.5,
    artistSplitPct: 60,
    companySplitPct: 40,
    referralLevels: []
  });
  assert.equal(r.bankFee, 25);
  assert.equal(r.netRevenue, 975);
  assert.equal(r.artistShare, 585);     // 975 * 0.60
  assert.equal(r.companyGross, 390);    // 975 * 0.40
  assert.equal(r.companyNet, 390);
  assert.equal(r.referralBreakdown.length, 0);
  assert.equal(r.totalReferrals, 0);
});

test('calculator: with L1 5% referral takes from company gross', () => {
  const r = calculate({
    grossRevenue: 5000,
    bankFeePct: 2.5,
    artistSplitPct: 60,
    companySplitPct: 40,
    referralLevels: [{ level: 1, referrerName: 'Sarah', commissionPct: 5 }]
  });
  assert.equal(r.bankFee, 125);
  assert.equal(r.netRevenue, 4875);
  assert.equal(r.artistShare, 2925);
  assert.equal(r.companyGross, 1950);
  assert.equal(r.referralBreakdown[0].amount, 97.5);  // 1950 * 0.05
  assert.equal(r.companyNet, 1852.5);
});

test('calculator: multiple referral levels each take from companyGross', () => {
  const r = calculate({
    grossRevenue: 1000,
    bankFeePct: 0,
    artistSplitPct: 50,
    companySplitPct: 50,
    referralLevels: [
      { level: 1, referrerName: 'L1', commissionPct: 10 },
      { level: 2, referrerName: 'L2', commissionPct: 5 }
    ]
  });
  assert.equal(r.companyGross, 500);
  assert.equal(r.referralBreakdown[0].amount, 50);  // 500 * 0.10
  assert.equal(r.referralBreakdown[1].amount, 25);  // 500 * 0.05
  assert.equal(r.totalReferrals, 75);
  assert.equal(r.companyNet, 425);
});

test('calculator: handles undefined referralLevels gracefully', () => {
  const r = calculate({
    grossRevenue: 100,
    bankFeePct: 0,
    artistSplitPct: 100,
    companySplitPct: 0,
    referralLevels: undefined
  });
  assert.equal(r.artistShare, 100);
  assert.equal(r.referralBreakdown.length, 0);
});
