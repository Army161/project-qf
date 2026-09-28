import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dec, fmt, cmp, add, sub, mul, div, fromRaw, toRaw, minDec, maxDec, median, ratioBps } from '../src/decimal.ts';

test('parses decimal strings exactly (no float)', () => {
  assert.equal(fmt(dec('24999.99')), '24999.99');
  assert.equal(fmt(dec('0.1')), '0.1');
  assert.equal(fmt(add(dec('0.1'), dec('0.2'))), '0.3'); // 0.1 + 0.2 !== 0.30000000000000004
  assert.equal(fmt(dec('-5')), '-5');
  assert.equal(fmt(dec('250000.000000000000000000')), '250000');
});

test('rejects malformed or over-precise input instead of silently rounding', () => {
  for (const bad of ['', '1e5', '1,000', 'NaN', '0x10', '1.', '.5', ' 1', '1.0000000000000000001']) {
    assert.throws(() => dec(bad), /invalid decimal|precision/, bad);
  }
  // JS numbers are not accepted for money
  assert.throws(() => dec(0.1 as unknown as string), /string/);
});

test('comparison is exact at boundaries', () => {
  assert.equal(cmp(dec('24999.99'), dec('25000')), -1);
  assert.equal(cmp(dec('25000.00'), dec('25000')), 0);
  assert.equal(cmp(dec('249999.99'), dec('250000')), -1);
  assert.equal(cmp(dec('250000'), dec('250000')), 0);
  assert.equal(cmp(dec('24999.999999999999999999'), dec('25000')), -1);
});

test('raw-unit conversion records rounding direction', () => {
  assert.equal(fmt(fromRaw(12_345_678n, 6)), '12.345678');
  assert.equal(toRaw(dec('12.3456789'), 6, 'DOWN'), 12_345_678n);
  assert.equal(toRaw(dec('12.3456781'), 6, 'UP'), 12_345_679n);
  assert.equal(toRaw(dec('12.345678'), 6, 'UP'), 12_345_678n);
  assert.throws(() => toRaw(dec('-1'), 6, 'DOWN'), /negative/);
});

test('mul/div with explicit rounding', () => {
  assert.equal(fmt(mul(dec('1.5'), dec('2'))), '3');
  assert.equal(fmt(div(dec('100000'), dec('3'), 'DOWN')), '33333.333333333333333333');
  assert.equal(fmt(div(dec('100000'), dec('3'), 'UP')), '33333.333333333333333334');
  assert.throws(() => div(dec('1'), dec('0'), 'DOWN'), /division by zero/);
  assert.equal(fmt(sub(dec('1'), dec('0.000000000000000001'))), '0.999999999999999999');
});

test('min / max / median / ratioBps', () => {
  assert.equal(fmt(minDec([dec('3'), dec('1'), dec('2')])), '1');
  assert.equal(fmt(maxDec([dec('3'), dec('1'), dec('2')])), '3');
  assert.equal(fmt(median([dec('3'), dec('1'), dec('2')])), '2');
  assert.equal(fmt(median([dec('1'), dec('2')])), '1.5');
  // (max - min) / min in basis points, rounded UP so disagreement is never understated
  assert.equal(ratioBps(dec('1.00'), dec('1.02')), 200n);
  assert.equal(ratioBps(dec('1.00'), dec('1.0201')), 201n);
  assert.equal(ratioBps(dec('1.00'), dec('1.02001')), 201n); // 200.1 bps rounds UP
});
