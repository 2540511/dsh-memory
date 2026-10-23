import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { parseMemoryFile } from '../src/format.js';
import { buildMemoryFileText } from '../src/compose.js';
import { extractDigest } from '../src/extract.js';
import {
  extractLongTerm, buildLongTermEntries, findConflicts, markPending,
} from '../src/longterm.js';

const { test, report } = createSuite('longterm');

const MESSAGES = [
  { role: 'assistant', text: '我建议记住：记忆只在工作区保存。', time: '2026-10-23T15:00:00+08:00', seq: 1 },
  { role: 'user', text: '记住：记忆只在工作区保存。', time: '2026-10-23T15:01:00+08:00', seq: 2 },
  { role: 'user', text: '我更偏好本地抽取，不要调用云端。', time: '2026-10-23T15:02:00+08:00', seq: 3 },
  { role: 'user', text: '下一步要做冲突解决界面。', time: '2026-10-23T15:03:00+08:00', seq: 4 },
  { role: 'user', text: '今天天气不错。', time: '2026-10-23T15:04:00+08:00', seq: 5 },
];

test('extractLongTerm: 只认用户表述，抽到约束/偏好/目标', () => {
  const items = extractLongTerm(MESSAGES);
  const kinds = items.map((item) => item.kind);
  assert.ok(kinds.includes('constraint'));
  assert.ok(kinds.includes('preference'));
  assert.ok(kinds.includes('goal'));
  assert.ok(!items.some((item) => item.quote.includes('我建议记住')), '助手的话不算用户要点');
  assert.ok(!items.some((item) => item.quote.includes('天气')), '闲聊不该被抽成要点');
});

test('extractLongTerm: quote 是原文子串，value 取自命中后的内容', () => {
  const items = extractLongTerm(MESSAGES);
  const constraint = items.find((item) => item.kind === 'constraint');
  assert.ok(MESSAGES.some((message) => message.text.includes(constraint.quote)));
  assert.ok(constraint.value.includes('记忆只在工作区保存'));
  assert.equal(constraint.time, '2026-10-23T15:01:00+08:00');
});

test('extractLongTerm: 同一句只归一类，重复内容去重', () => {
  const items = extractLongTerm([
    { role: 'user', text: '记住：不要发送任何内容。', time: null, seq: 1 },
    { role: 'user', text: '记住：不要发送任何内容。', time: null, seq: 2 },
  ]);
  assert.equal(items.length, 1);
});

const BUILT = buildLongTermEntries(extractLongTerm(MESSAGES), {
  savedAt: '2026-10-23T16:00:00+08:00',
  timezone: 'Asia/Shanghai',
  stamp: '2026-10-23_160000',
  seqStart: 2,
});

test('buildLongTermEntries: 不衰减、不回收、带 kind/value/subject', () => {
  assert.ok(BUILT.length >= 3);
  for (const entry of BUILT) {
    assert.equal(entry.fieldMap.type, 'long_term');
    assert.equal(entry.fieldMap.weight, '100');
    assert.equal(entry.fieldMap.decay, 'none');
    assert.equal(entry.fieldMap.purge_after, 'never');
    assert.equal(entry.fieldMap.status, 'current');
    assert.ok(entry.fieldMap.kind);
    assert.ok(entry.fieldMap.value);
  }
  assert.deepEqual(BUILT.map((entry) => Number(entry.fieldMap.seq)), [2, 3, 4]);
});

test('buildLongTermEntries: 长期要点条目能被格式层解析', () => {
  const digest = extractDigest(MESSAGES, {});
  const built = buildMemoryFileText({
    digest,
    session: { sessionId: 's1', title: 't', messageRange: '1-5', coversFrom: 'unknown', coversTo: '2026-10-23T16:00:00+08:00' },
    stamp: '2026-10-23_160000',
    savedAt: '2026-10-23T16:00:00+08:00',
    timezone: 'Asia/Shanghai',
    memoryClass: 'chat',
    fileName: '2026-10-23_160000.md',
    extraEntries: BUILT,
  });
  const doc = parseMemoryFile(built.text);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
  assert.equal(doc.entries.length, 1 + BUILT.length);
  assert.equal(doc.frontMatter.data.entries, String(1 + BUILT.length));
  assert.equal(doc.indexSection.rows.length, 1 + BUILT.length);
  assert.equal(built.entries, 1 + BUILT.length);
});

test('findConflicts: 同 kind 值不同才算冲突', () => {
  const existing = [
    { file: 'a.md', entry: { id: 'LT-OLD', fieldMap: { type: 'long_term', kind: 'constraint', value: '记忆只在工作区保存（网盘）', status: 'current' } } },
    { file: 'b.md', entry: { id: 'LT-SAME', fieldMap: { type: 'long_term', kind: 'goal', value: '做界面', status: 'current' } } },
    { file: 'c.md', entry: { id: 'LT-DEAD', fieldMap: { type: 'long_term', kind: 'preference', value: '旧的', status: 'superseded' } } },
  ];
  const incoming = [
    { id: 'LT-NEW-1', fieldMap: { type: 'long_term', kind: 'constraint', value: '记忆只在工作区保存（本地）' }, fields: [], bodyLines: [] },
    { id: 'LT-NEW-2', fieldMap: { type: 'long_term', kind: 'goal', value: '做界面' }, fields: [], bodyLines: [] },
  ];
  const conflicts = findConflicts(incoming, existing);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].entry.id, 'LT-NEW-1');
  assert.equal(conflicts[0].against.id, 'LT-OLD');
});

test('findConflicts: 公共前缀太短不判冲突（宁可漏报，不制造噪音）', () => {
  const existing = [
    { file: 'a.md', entry: { id: 'LT-A', fieldMap: { type: 'long_term', kind: 'constraint', value: '只在工作区保存', status: 'current' } } },
  ];
  const incoming = [
    { id: 'LT-B', fieldMap: { type: 'long_term', kind: 'constraint', value: '永久保留源文件' }, fields: [], bodyLines: [] },
  ];
  assert.equal(findConflicts(incoming, existing).length, 0);
});

test('extractLongTerm: 有上限，只取最近几条', () => {
  const noisy = Array.from({ length: 20 }, (_, index) => ({
    role: 'user', text: `记住：规则编号 ${index} 必须保留。`, time: null, seq: index,
  }));
  const items = extractLongTerm(noisy, { max: 5 });
  assert.equal(items.length, 5);
});

test('markPending: 标 pending 并写明双方值，旧条目不动', () => {
  const entry = {
    id: 'LT-NEW',
    fields: [
      { key: 'status', value: 'current' },
      { key: 'updated_at', value: '2026-10-23T16:00:00+08:00' },
    ],
    fieldMap: { kind: 'constraint', value: '记忆只在工作区保存', status: 'current' },
    bodyLines: ['原文摘录。'],
  };
  markPending(entry, { value: '记忆存在网盘', id: 'LT-OLD', file: 'a.md' }, { at: '2026-10-23T16:05:00+08:00' });
  assert.equal(entry.fieldMap.status, 'pending');
  assert.equal(entry.fields.find((field) => field.key === 'status').value, 'pending');
  assert.equal(entry.fields.find((field) => field.key === 'updated_at').value, '2026-10-23T16:05:00+08:00');
  const body = entry.bodyLines.join('\n');
  assert.ok(body.includes('> [!conflict]'));
  assert.ok(body.includes('旧值: 记忆存在网盘'));
  assert.ok(body.includes('新值: 记忆只在工作区保存'));
});

test('markPending: 冲突块能被格式层识别为 conflict', () => {
  const entry = {
    id: 'LT-NEW',
    title: '长期要点',
    fields: [
      { key: 'type', value: 'long_term' },
      { key: 'event_time', value: '2026-10-23T16:00:00+08:00' },
      { key: 'recorded_at', value: '2026-10-23T16:00:00+08:00' },
      { key: 'updated_at', value: '2026-10-23T16:05:00+08:00' },
      { key: 'timezone', value: 'Asia/Shanghai' },
      { key: 'time_source', value: 'system_clock' },
      { key: 'confidence', value: '0.8' },
      { key: 'privacy', value: 'device_local' },
      { key: 'status', value: 'pending' },
      { key: 'tags', value: 'long_term' },
      { key: 'seq', value: '2' },
    ],
    fieldMap: {},
    bodyLines: ['原文。'],
  };
  entry.fieldMap = Object.fromEntries(entry.fields.map((field) => [field.key, field.value]));
  entry.fieldMap.kind = 'constraint';
  entry.fieldMap.value = '新值';
  markPending(entry, { value: '旧值', id: 'LT-OLD', file: 'a.md' });
  assert.ok(entry.bodyLines.some((line) => line.startsWith('> [!conflict]')));
});

process.exitCode = report() > 0 ? 1 : 0;
