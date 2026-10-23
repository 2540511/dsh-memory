import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { parseMemoryFile } from '../src/format.js';
import { estimateTokens } from '../src/format.js';
import {
  computeWeight, bucketOf, shouldPurge, purgeDetail, buildStartupIndex, summaryLine,
} from '../src/weight.js';

const { test, report } = createSuite('weight');

const NOW = Date.parse('2026-10-23T16:00:00+08:00');

test('computeWeight: 20 天内满权', () => {
  const r = computeWeight({ eventTime: '2026-10-20T16:00:00+08:00', now: NOW });
  assert.equal(r.decay, 1);
  assert.equal(r.weight, 60);
  assert.equal(r.bucket, 'warm');
});

test('computeWeight: 超过 20 天开始衰减，权重下降但不会消失', () => {
  const r = computeWeight({ eventTime: '2026-06-01T16:00:00+08:00', now: NOW, floor: 5 });
  assert.ok(r.decay < 0.1, `decay=${r.decay}`);
  assert.equal(r.weight, 5, '降到下限为止');
  assert.equal(r.bucket, 'dormant');
});

test('computeWeight: 长文本记忆不参与衰减（base 100 且无 event_time）', () => {
  const r = computeWeight({ base: 100, eventTime: '2026-06-01T16:00:00+08:00', now: NOW });
  assert.ok(r.weight >= 5);
});

test('bucketOf: 分桶边界', () => {
  assert.equal(bucketOf(100), 'hot');
  assert.equal(bucketOf(70), 'hot');
  assert.equal(bucketOf(69), 'warm');
  assert.equal(bucketOf(40), 'warm');
  assert.equal(bucketOf(39), 'cold');
  assert.equal(bucketOf(15), 'cold');
  assert.equal(bucketOf(14), 'dormant');
});

test('shouldPurge: 20 天阈值', () => {
  assert.equal(shouldPurge('2026-10-10T16:00:00+08:00', NOW, 20), false);
  assert.equal(shouldPurge('2026-10-01T16:00:00+08:00', NOW, 20), true);
  assert.equal(shouldPurge('unknown', NOW, 20), false);
});

const BODY = [
  '要点：',
  '- [用户·决策] 决定改成 B 方案。',
  '',
  '### 增量',
  '',
  '- 2026-09-01T10:00:00+08:00 决定改成 B 方案。',
  '- 2026-09-01T10:01:00+08:00 不再调用云端。',
  '',
  '### 承接',
  '',
  '> 沿用上一条摘要。',
  '- 旧要点。',
  '',
  '> [!note] 权威内容以源记忆文件为准。',
];

test('purgeDetail: 只删增量区块，要点与指针保留', () => {
  const result = purgeDetail(BODY, { at: '2026-10-23T16:00:00+08:00', days: 20 });
  assert.equal(result.purged, true);
  const text = result.bodyLines.join('\n');
  assert.ok(!text.includes('不再调用云端'), '明细应被删除');
  assert.ok(text.includes('要点：'));
  assert.ok(text.includes('决定改成 B 方案。'), '要点里的同一句话要保留');
  assert.ok(text.includes('### 承接'));
  assert.ok(text.includes('> [!note] 权威内容'));
  assert.ok(text.includes('> [!purged]'));
});

test('purgeDetail: 没有增量区块时不动', () => {
  const body = ['要点：', '- 一句话。', '', '> [!note] 指针。'];
  const result = purgeDetail(body, { at: 'now', days: 20 });
  assert.equal(result.purged, false);
  assert.deepEqual(result.bodyLines, body);
});

test('purgeDetail: 回收后仍能被格式层解析', () => {
  const result = purgeDetail(BODY, { at: '2026-10-23T16:00:00+08:00', days: 20 });
  const text = [
    '---',
    'memory_format: dsh-memory',
    'format_version: 1',
    'saved_at: 2026-10-23T16:00:00+08:00',
    '---',
    '',
    '## [T-1] 测试',
    '',
    '- type: session_digest',
    '- event_time: 2026-09-01T10:00:00+08:00',
    '- recorded_at: 2026-09-01T10:00:00+08:00',
    '- updated_at: 2026-10-23T16:00:00+08:00',
    '- timezone: Asia/Shanghai',
    '- time_source: system_clock',
    '- confidence: 0.7',
    '- privacy: device_local',
    '- status: current',
    '- tags: t',
    '- seq: 1',
    '',
    ...result.bodyLines,
    '',
  ].join('\n');
  const doc = parseMemoryFile(text);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
  assert.ok(doc.entries[0].blocks.some((block) => block.tag === 'purged'));
});

test('summaryLine: 优先取要点里的第一条', () => {
  const entry = { title: '会话总结 · 某会话', bodyLines: ['要点：', '- [用户·决策] 定下 B 方案。'] };
  assert.equal(summaryLine(entry), '[用户·决策] 定下 B 方案。');
});

function makeDoc(id, type, eventTime, bodyLines, weight) {
  return {
    file: `${id}.md`,
    entry: {
      id,
      title: `条目 ${id}`,
      fieldMap: { type, event_time: eventTime, status: 'current', weight: String(weight) },
      bodyLines,
      blocks: [],
      fields: [],
    },
  };
}

test('buildStartupIndex: 长期要点优先，链头必带，超预算不再追加', () => {
  const docs = [
    makeDoc('L-1', 'long_term', '2026-01-01T00:00:00+08:00', ['长期要点：用户偏好本地抽取。'], 100),
    makeDoc('SG-OLD', 'session_digest', '2026-09-01T00:00:00+08:00', ['要点：', '- [用户·决策] 旧决策。'], 20),
    makeDoc('SG-NEW', 'session_digest', '2026-10-23T00:00:00+08:00', ['要点：', '- [用户·决策] 新决策。'], 60),
    makeDoc('WK-1', 'work_record', '2026-10-23T00:00:00+08:00', ['逐字内容'], 0),
  ];
  const index = buildStartupIndex(docs, { now: NOW, budget: 120, estimateTokens });
  assert.ok(index.text.includes('L-1'));
  assert.ok(index.text.includes('SG-NEW'), '链头必带');
  assert.ok(index.tokens <= 160, `tokens=${index.tokens}`);
  assert.ok(!index.text.includes('逐字内容'), '工作记忆条目不进启动包');
  assert.ok(index.text.includes('权威内容以条目正文为准'));
  assert.ok(index.text.includes('pending / superseded'));
});

test('buildStartupIndex: 空记忆返回只有说明的索引', () => {
  const index = buildStartupIndex([], { now: NOW, budget: 800, estimateTokens });
  assert.ok(index.text.includes('记忆索引'));
  assert.equal(index.included.length, 0);
});

process.exitCode = report() > 0 ? 1 : 0;
