/**
 * Revenue Distribution Calculator
 * Calculates how revenue is split between artist, company, and referrals
 */
function calculate({ grossRevenue, bankFeePct, artistSplitPct, companySplitPct, referralLevels }) {
  // Step 1: Deduct bank fee
  const bankFee = round(grossRevenue * (bankFeePct / 100));
  const netRevenue = round(grossRevenue - bankFee);

  // Step 2: Split between artist and company
  const artistShare = round(netRevenue * (artistSplitPct / 100));
  const companyGross = round(netRevenue * (companySplitPct / 100));

  // Step 3: Calculate referral commissions from company's share
  const referralBreakdown = (referralLevels || []).map(level => {
    const amount = round(companyGross * (level.commissionPct / 100));
    return {
      level: level.level,
      referrerName: level.referrerName,
      commissionPct: level.commissionPct,
      amount
    };
  });

  const totalReferrals = round(referralBreakdown.reduce((sum, r) => sum + r.amount, 0));
  const companyNet = round(companyGross - totalReferrals);

  return {
    grossRevenue: round(grossRevenue),
    bankFeePct,
    bankFee,
    netRevenue,
    artistSplitPct,
    artistShare,
    companySplitPct,
    companyGross,
    referralBreakdown,
    totalReferrals,
    companyNet
  };
}

function round(num) {
  return Math.round(num * 100) / 100;
}

module.exports = { calculate };
