'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findCol } = require('../services/royaltyShower.js');

// Real Orchard header order — note PRODUCT ARTIST and TRACK ARTIST appear
// BEFORE the real TRACK (song title) column.
const ORCHARD = [
  'STATEMENT PERIOD', 'SALE COUNTRY', 'STORE', 'PRODUCT ARTIST', 'PRODUCT',
  'TRACK ARTIST', 'TRACK', 'TRACK VERSION', 'TRANSACTION TYPE',
  'TRANSACTION SUBTYPE', 'QUANTITY', 'NET SHARE ACCOUNT CURRENCY',
];

test('track column resolves to the real TRACK title, not TRACK ARTIST', () => {
  assert.equal(findCol(ORCHARD, 'TRACK TITLE', 'TRACK', 'SONG', 'PRODUCT'), 'TRACK');
});

test('other columns resolve to the correct Orchard headers', () => {
  assert.equal(findCol(ORCHARD, 'PRODUCT ARTIST', 'TRACK ARTIST', 'ARTIST NAME', 'ARTIST'), 'PRODUCT ARTIST');
  assert.equal(findCol(ORCHARD, 'STORE', 'PLATFORM', 'DSP', 'SERVICE'), 'STORE');
  assert.equal(findCol(ORCHARD, 'SALE COUNTRY', 'COUNTRY', 'TERRITORY', 'REGION'), 'SALE COUNTRY');
  assert.equal(findCol(ORCHARD, 'REPORTING MONTH', 'SALES MONTH', 'STATEMENT PERIOD', 'PERIOD', 'MONTH', 'DATE'), 'STATEMENT PERIOD');
  assert.equal(findCol(ORCHARD, 'TRANSACTION TYPE', 'SALES TYPE', 'SALE TYPE'), 'TRANSACTION TYPE');
  assert.equal(findCol(ORCHARD, 'NET REVENUE', 'NET SHARE ACCOUNT CURRENCY', 'NET SHARE', 'EARNINGS', 'REVENUE'), 'NET SHARE ACCOUNT CURRENCY');
});

test('falls back to substring match when no exact header exists', () => {
  const headers = ['Primary Artist', 'Sale Country', 'Net Revenue'];
  assert.equal(findCol(headers, 'PRODUCT ARTIST', 'TRACK ARTIST', 'ARTIST NAME', 'ARTIST'), 'Primary Artist');
  assert.equal(findCol(headers, 'NET REVENUE', 'NET SHARE'), 'Net Revenue');
});
