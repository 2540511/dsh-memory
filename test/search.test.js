import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { tokenize, searchEntries, makeSnippet, freshness, scoreEntry } from '../src/search.js';

const { test, report } = createSuite('search');

function entry(id, title, body, extra = {}) {
  const fields = { type: 'session_digest', event_time: '2026-10-23T15:00:00+08:00', status: 'current', tags: 'session, digest', ...extra };
  return {
    id,
    title,
    bodyLines: body.split('\n'),
    fieldMap: fields,
  };
}

const DOCS = [
  { file: '2026-10-23_150000.md', entry: entry('SG-1', '摘要方案改为本地抽取', '决定：摘要改成 B 方案，不发送任何内容。\n权重与 20 天回收另行设计。') },
  { file: '2026-10-23_160000.md', entry: entry('SG-2', '记忆权重与回收', '要点：超过 20 天回收增量明细。\n源文件永久保留。') },
  { file: '2026-10-23_170000.md', entry: entry('SG-3', '工作记忆保存', '工作记忆必须逐字保存，diff 单独生成。', { type: 'work_digest', event_time: '2026-09-01T10:00:00+08:00' }) },
];

test('tokenize: 空格与标点切分，丢弃单字', () => {
  assert.deepEqual(tokenize('记忆 权重'), ['记忆', '权重']);
  assert.deepEqual(tokenize('a，b、c'), ['a', 'b', 'c'].filter((x) => x.length >= 2));
  assert.deepEqual(tokenize('   '), []);
});

test('tokenize: 中文长词补二元组，提升召回', () => {
  const terms = tokenize('记忆权重');
  assert.ok(terms.includes('记忆权重'));
  assert.ok(terms.includes('记忆'));
  assert.ok(terms.includes('权重'));
});

test('search: 标题命中排前，正文命中也能找到', () => {
  const result = searchEntries(DOCS, '权重', { now: Date.parse('2026-10-23T18:00:00+08:00') });
  assert.ok(result.hits.length >= 2);
  assert.equal(result.hits[0].id, 'SG-2', '标题含"权重"的应排第一');
  assert.ok(result.hits.some((hit) => hit.id === 'SG-1'), '正文提到权重的也要命中');
});

test('search: 中文短语用二元组跨词命中', () => {
  const result = searchEntries(DOCS, '记忆的权重', { now: Date.parse('2026-10-23T18:00:00+08:00') });
  assert.ok(result.hits.length > 0);
});

test('search: 类型过滤与时间范围', () => {
  const work = searchEntries(DOCS, '保存', { type: 'work_digest' });
  assert.deepEqual(work.hits.map((hit) => hit.id), ['SG-3']);

  const recent = searchEntries(DOCS, '回收', {
    from: '2026-10-20T00:00:00+08:00',
    now: Date.parse('2026-10-23T18:00:00+08:00'),
  });
  assert.ok(recent.hits.every((hit) => hit.id !== 'SG-3'));

  const ancient = searchEntries(DOCS, '保存', { to: '2026-10-01T00:00:00+08:00' });
  assert.deepEqual(ancient.hits.map((hit) => hit.id), ['SG-3']);
});

test('search: 无命中返回空数组，不编造', () => {
  const result = searchEntries(DOCS, '量子引力');
  assert.equal(result.hits.length, 0);
  assert.ok(result.scanned > 0);
});

test('search: 空查询不返回任何记忆', () => {
  const result = searchEntries(DOCS, '   ');
  assert.equal(result.hits.length, 0);
  assert.deepEqual(result.terms, []);
});

test('search: 命中项带来源、时间、权重、时效', () => {
  const result = searchEntries(DOCS, '权重', { now: Date.parse('2026-10-23T18:00:00+08:00') });
  const hit = result.hits[0];
  assert.equal(hit.file, '2026-10-23_160000.md');
  assert.equal(hit.eventTime, '2026-10-23T15:00:00+08:00');
  assert.equal(hit.status, 'current');
  assert.equal(hit.freshness, 'fresh');
  assert.ok(typeof hit.score === 'number');
  assert.ok(hit.snippet.length > 0);
});

test('makeSnippet: 围绕命中词取窗口并加省略号', () => {
  const body = `${'前'.repeat(200)}关键词${'后'.repeat(200)}`;
  const snippet = makeSnippet([body], ['关键词'], 60);
  assert.ok(snippet.includes('关键词'));
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.endsWith('…'));
  assert.ok(snippet.length < 90);
});

test('makeSnippet: 正文为空不崩', () => {
  assert.equal(makeSnippet([], ['x']), '');
});

test('freshness: 20 天内新鲜，60 天后过时，未来时间标异常', () => {
  const now = Date.parse('2026-10-23T18:00:00+08:00');
  assert.equal(freshness('2026-10-20T18:00:00+08:00', now), 'fresh');
  assert.equal(freshness('2026-09-01T18:00:00+08:00', now), 'aging');
  assert.equal(freshness('2026-06-01T18:00:00+08:00', now), 'stale');
  assert.equal(freshness('unknown', now), 'unknown');
  assert.equal(freshness('2026-12-01T18:00:00+08:00', now), 'anomaly');
});

test('search: 代码 diff 的排序低于摘要条目', () => {
  const docs = [
    { file: 'a.md', entry: entry('SG-X', '权重设计', '这里讨论权重。') },
    { file: 'b.md', entry: entry('WD-X', '变更 · src/search.js', '权重 权重 权重 权重 权重', { type: 'work_diff' }) },
  ];
  const result = searchEntries(docs, '权重');
  assert.equal(result.hits[0].type, 'session_digest', `top=${result.hits[0].type}`);
  assert.ok(result.hits[0].score > result.hits[1].score);
});

test('scoreEntry: 标题权重高于正文', () => {
  const titleHit = scoreEntry(entry('A', '权重设计', '无关内容。'), ['权重']);
  const bodyHit = scoreEntry(entry('B', '无关标题', '这里提到权重一次。'), ['权重']);
  assert.ok(titleHit.score > bodyHit.score);
});

process.exitCode = report() > 0 ? 1 : 0;
