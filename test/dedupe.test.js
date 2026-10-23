import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { findDuplicates } from '../src/dedupe.js';

const { test, report } = createSuite('dedupe');

function doc(file, id, fields) {
  return { file, entry: { id, fieldMap: { status: 'current', ...fields }, bodyLines: [], fields: [] } };
}

test('findDuplicates: 同 kind + 同 value 的长期要点算重复', () => {
  const docs = [
    doc('a.md', 'LT-1', { type: 'long_term', kind: 'constraint', value: '只在工作区保存', recorded_at: '2026-10-23T16:00:00+08:00' }),
    doc('b.md', 'LT-2', { type: 'long_term', kind: 'constraint', value: '只在工作区保存 ', recorded_at: '2026-10-23T16:10:00+08:00' }),
  ];
  const groups = findDuplicates(docs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keeper.entry.id, 'LT-1', '保留更早的那条');
  assert.deepEqual(groups[0].duplicates.map((item) => item.entry.id), ['LT-2']);
});

test('findDuplicates: 值不同不算重复', () => {
  const docs = [
    doc('a.md', 'LT-1', { type: 'long_term', kind: 'constraint', value: '只在工作区保存' }),
    doc('b.md', 'LT-2', { type: 'long_term', kind: 'constraint', value: '存在网盘' }),
  ];
  assert.equal(findDuplicates(docs).length, 0);
});

test('findDuplicates: 已 superseded 的不参与', () => {
  const docs = [
    doc('a.md', 'LT-1', { type: 'long_term', kind: 'constraint', value: 'x' }),
    doc('b.md', 'LT-2', { type: 'long_term', kind: 'constraint', value: 'x', status: 'superseded' }),
  ];
  assert.equal(findDuplicates(docs).length, 0);
});

test('findDuplicates: 多媒体按 media_source 去重，有描述的优先保留', () => {
  const docs = [
    doc('a.md', 'MD-1', { type: 'media_summary', media_source: 'sha256:abc', media_desc_status: 'pending', recorded_at: '2026-10-23T16:00:00+08:00' }),
    doc('b.md', 'MD-2', { type: 'media_summary', media_source: 'sha256:abc', media_desc_status: 'current', recorded_at: '2026-10-23T16:10:00+08:00' }),
  ];
  const groups = findDuplicates(docs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keeper.entry.id, 'MD-2');
  assert.deepEqual(groups[0].duplicates.map((item) => item.entry.id), ['MD-1']);
});

test('findDuplicates: 不同附件不算重复', () => {
  const docs = [
    doc('a.md', 'MD-1', { type: 'media_summary', media_source: 'sha256:a' }),
    doc('b.md', 'MD-2', { type: 'media_summary', media_source: 'sha256:b' }),
  ];
  assert.equal(findDuplicates(docs).length, 0);
});

test('findDuplicates: 三类重复混在一起互不干扰', () => {
  const docs = [
    doc('a.md', 'LT-1', { type: 'long_term', kind: 'goal', value: '做 L2' }),
    doc('b.md', 'LT-2', { type: 'long_term', kind: 'goal', value: '做 L2' }),
    doc('c.md', 'SG-1', { type: 'session_digest', value: '做 L2' }),
  ];
  const groups = findDuplicates(docs);
  assert.equal(groups.length, 1, '只有 long_term 成组，摘要不参与');
});

process.exitCode = report() > 0 ? 1 : 0;
