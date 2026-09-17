/**
 * Closes the Python-to-JS loop for the calculator.
 *
 * The export computes each window's fee kernel in Python; the browser evaluates it in
 * JavaScript. If those two disagree the site shows numbers its own data does not support,
 * so these tests evaluate the SHIPPED kernels and check them against the totals the export
 * shipped alongside them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import { evaluateKernel, histogram, netVsHodlPct, quantile } from '../archive/lib/kernel.js';

const dataUrl = (/** @type {string} */ p) => new URL(`../web/data/${p}`, import.meta.url);
const index = JSON.parse(await readFile(dataUrl('windows.json'), 'utf8'));
const poolFiles = (await readdir(dataUrl('windows/'))).filter((f) => f.endsWith('.json'));

test('the shipped index is columnar and internally consistent', () => {
  const lengths = Object.values(index.columns).map((c) => c.length);
  assert.equal(new Set(lengths).size, 1, 'ragged columns');
  assert.equal(lengths[0], index.count);
  assert.ok(index.count > 1000, `only ${index.count} windows shipped`);
});

test('evaluating a shipped kernel reproduces the export total at scale', async () => {
  // As position size runs away the position earns every fee in the window, so the kernel
  // must converge on fees_total_usd — the figure Python computed from the raw tape.
  let checked = 0;
  for (const file of poolFiles.slice(0, 20)) {
    const pool = JSON.parse(await readFile(dataUrl(`windows/${file}`), 'utf8'));
    for (let i = 0; i < pool.window_index.length; i++) {
      const totals = pool.fee_kernel_totals[i];
      if (!totals.length) continue;
      const active = pool.fee_kernel_active[i];
      const expected = index.columns.fees_total_usd[pool.window_index[i]];
      const huge = evaluateKernel(totals, active, pool.liquidity_per_dollar[i] * 1e18);
      assert.ok(Math.abs(huge / expected - 1) < 1e-4,
        `${file} window ${i}: ${huge} vs shipped ${expected}`);
      checked += 1;
    }
  }
  assert.ok(checked > 200, `only checked ${checked} kernels`);
});

test('fees are monotone and sublinear in position size', async () => {
  const pool = JSON.parse(await readFile(dataUrl(`windows/${poolFiles[0]}`), 'utf8'));
  const i = pool.fee_kernel_totals.findIndex((/** @type {number[]} */ t) => t.length > 0);
  assert.ok(i >= 0);
  const totals = pool.fee_kernel_totals[i];
  const active = pool.fee_kernel_active[i];
  const k = pool.liquidity_per_dollar[i];
  let previous = 0;
  let previousPerDollar = Infinity;
  for (const size of [100, 1_000, 10_000, 100_000, 1_000_000]) {
    const fees = evaluateKernel(totals, active, k * size);
    assert.ok(fees > previous, 'fees must rise with size');
    // Doubling a position never doubles its share of a pool it is already crowding.
    assert.ok(fees / size <= previousPerDollar + 1e-12, 'fees per dollar must not rise');
    previous = fees;
    previousPerDollar = fees / size;
  }
});

test('net versus holding splits into a fee term and a size-independent IL term', async () => {
  const pool = JSON.parse(await readFile(dataUrl(`windows/${poolFiles[0]}`), 'utf8'));
  const i = pool.fee_kernel_totals.findIndex((/** @type {number[]} */ t) => t.length > 0);
  const slot = pool.window_index[i];
  const w = {
    il_vs_hodl_pct: index.columns.il_vs_hodl_pct[slot],
    liquidity_per_dollar: pool.liquidity_per_dollar[i],
  };
  const totals = pool.fee_kernel_totals[i];
  const active = pool.fee_kernel_active[i];

  const small = netVsHodlPct(w, totals, active, 1_000);
  const large = netVsHodlPct(w, totals, active, 1_000_000);
  assert.equal(small.ilPct, large.ilPct, 'the IL term must not move with size');
  assert.ok(small.feesPct >= large.feesPct, 'fee yield must not rise with size');
  assert.equal(small.netPct, small.feesPct + small.ilPct);
});

test('zero and empty inputs return zero rather than NaN', () => {
  assert.equal(evaluateKernel([], [], 1e18), 0);
  assert.equal(evaluateKernel([1], [1], 0), 0);
  assert.equal(evaluateKernel([1], [1], -5), 0);
});

test('quantiles and histogram behave on a known sample', () => {
  const values = [1, 2, 3, 4, 5];
  assert.equal(quantile(values, 0.5), 3);
  assert.equal(quantile(values, 0), 1);
  assert.equal(quantile(values, 1), 5);
  assert.ok(Number.isNaN(quantile([], 0.5)));
  const { counts } = histogram(values, 5);
  assert.equal(counts.reduce((a, b) => a + b, 0), 5);
  assert.equal(histogram([7, 7, 7], 4).counts.reduce((a, b) => a + b, 0), 3);
});
