#!/usr/bin/env node
/**
 * Import artists from Excel file into the deployed Railway app.
 * Usage: node scripts/import-artists.js <xlsx-path> <base-url> <username> <password>
 */

const ExcelJS = require('exceljs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const xlsxPath = process.argv[2] || 'C:/Users/PC/Downloads/Artist List DangParez.xlsx';
const baseUrl = process.argv[3] || 'https://app-production-0a17.up.railway.app';
const username = process.argv[4] || 'admin';
const password = process.argv[5] || 'admin123';

let sessionCookie = '';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const client = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', 'Cookie': sessionCookie }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = client.request(opts, res => {
      if (res.headers['set-cookie']) sessionCookie = res.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: d ? JSON.parse(d) : null }); }
        catch (e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login() {
  const r = await request('POST', '/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error('Login failed: ' + JSON.stringify(r.data));
  console.log('Logged in as:', r.data.name);
}

function extractValue(cell) {
  let v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.text) return v.text;
    if (v.result !== undefined) return v.result;
    if (v.richText) return v.richText.map(r => r.text).join('');
    return null;
  }
  return v;
}

async function main() {
  console.log('Reading Excel file:', xlsxPath);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const sheet = wb.worksheets[0];

  const headers = {};
  sheet.getRow(1).eachCell((cell, col) => { headers[col] = cell.value?.toString().trim(); });

  const artists = [];
  sheet.eachRow((row, num) => {
    if (num === 1) return;
    const data = {};
    row.eachCell((cell, col) => {
      data[headers[col]] = extractValue(cell);
    });
    if (data['Name']) artists.push(data);
  });
  console.log('Parsed', artists.length, 'artists from Excel');

  await login();

  // Get existing artists to skip duplicates
  const existing = await request('GET', '/api/artists');
  const existingNames = new Set(existing.data.map(a => a.name.toLowerCase().trim()));
  console.log('Existing artists in DB:', existingNames.size);

  let imported = 0, skipped = 0, failed = 0;
  for (const a of artists) {
    const name = (a['Name'] || '').toString().trim();
    if (!name) { skipped++; continue; }
    if (existingNames.has(name.toLowerCase())) { skipped++; continue; }

    // Parse %: if it's a decimal like 0.6, multiply by 100
    let artistSplit = parseFloat(a['%']);
    if (isNaN(artistSplit)) artistSplit = 60;
    if (artistSplit <= 1) artistSplit = artistSplit * 100;
    artistSplit = Math.max(0, Math.min(100, artistSplit));
    const companySplit = 100 - artistSplit;

    const notes = [];
    if (a['Phone']) notes.push('Phone: ' + a['Phone']);
    if (a['Phone2']) notes.push('Phone2: ' + a['Phone2']);
    if (a['Beneficiary']) notes.push('Beneficiary: ' + a['Beneficiary']);
    if (a['Start Date']) notes.push('Contract: ' + a['Start Date'] + ' to ' + (a['End Date'] || '?'));
    if (a['Years']) notes.push('Years: ' + a['Years']);
    if (a['Notes']) notes.push(a['Notes']);

    // If there's a "Refro" (referrer), add it as a level 1 referral with default 5% commission
    const referrals = [];
    if (a['Refro'] && a['Refro'].toString().trim()) {
      referrals.push({
        level: 1,
        referrer_name: a['Refro'].toString().trim(),
        commission_pct: 5
      });
    }

    const payload = {
      name,
      nickname: a['Nick Name'] ? a['Nick Name'].toString().trim() : null,
      revenue_type: 'both',
      artist_split_pct: artistSplit,
      company_split_pct: companySplit,
      bank_fee_pct: 2.5,
      notes: notes.join(' | ') || null,
      referrals
    };

    try {
      const r = await request('POST', '/api/artists', payload);
      if (r.status === 201 || r.status === 200) {
        imported++;
        if (imported % 20 === 0) console.log('  Imported', imported, '/', artists.length);
      } else {
        failed++;
        console.log('  FAILED:', name, '-', r.status, r.data);
      }
    } catch (e) {
      failed++;
      console.log('  ERROR:', name, '-', e.message);
    }
  }

  console.log('\n=== Import complete ===');
  console.log('Imported:', imported);
  console.log('Skipped (duplicates/empty):', skipped);
  console.log('Failed:', failed);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
