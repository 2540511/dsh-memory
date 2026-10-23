import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { parseMemoryFile, serializeMemoryFile } from '../src/format.js';
import { extractDigest } from '../src/extract.js';
import { extractMessages, summarizeEvents, sanitizeUserText } from '../src/sessions.js';
import { buildMemoryFileText, digestId, purgeRegion, PURGE_HEADING } from '../src/compose.js';

const { test, report } = createSuite('compose');

const toIso = (ms) => new Date(ms).toISOString().replace('Z', '+00:00');

const EVENTS = [
  { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1100, surfaceOp: 'append', data: { content: [{ type: 'text', text: '把摘要改成纯本地抽取，别再发云端。' }] } },
  { type: 'assistant/message', seq: 2, time: 1200, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '好的，我改成抽取式，不发送任何内容。' }] } } },
  { type: 'assistant/message', seq: 3, time: 1300, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, data: { message: { content: [{ type: 'text', text: '被替换掉的旧回复。' }] } } },
  { type: 'tool/result', seq: 4, time: 1400, surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'exit code 1' }] }, error: { name: 'ShellError', code: 'E1' } } },
  { type: 'user/message', seq: 5, time: 1500, surfaceOp: 'append', data: { content: [{ type: 'text', text: '工作记忆要完全详细保存，diff 单独生成。' }] } },
];

test('extractMessages: 只取当前表面，被替换的历史不参与', () => {
  const messages = extractMessages(EVENTS, toIso);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.ok(!messages.some((m) => m.text.includes('被替换掉')));
  assert.ok(messages[2].text.includes('工具失败'));
});

test('summarizeEvents: 消息数与时间范围', () => {
  const summary = summarizeEvents(EVENTS);
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.startTime, 1000);
  assert.equal(summary.endTime, 1500);
});

const SESSION = {
  sessionId: 'sess_test_1',
  title: '长记忆插件 · 保存链路',
  messageRange: '1-4',
  coversFrom: '2026-10-23T15:29:12+08:00',
  coversTo: '2026-10-23T15:40:00+08:00',
};

function buildFixture() {
  const messages = extractMessages(EVENTS, toIso);
  const digest = extractDigest(messages, { charBudget: 600 });
  return buildMemoryFileText({
    digest,
    session: SESSION,
    stamp: '2026-10-23_154106',
    savedAt: '2026-10-23T15:41:06+08:00',
    timezone: 'Asia/Shanghai',
    memoryClass: 'chat',
    fileName: '2026-10-23_154106.md',
    purgeAfter: '2026-11-12T15:40:00+08:00',
  });
}

test('digestId: SG-YYYYMMDD-HHmmss', () => {
  assert.equal(digestId('2026-10-23_154106'), 'SG-2026-10-23-154106');
});

test('buildMemoryFileText: 能被格式层完整解析且无告警', () => {
  const { text, entryId, indexTokensEst } = buildFixture();
  const doc = parseMemoryFile(text);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].id, entryId);
  assert.equal(doc.frontMatter.data.memory_format, 'dsh-memory');
  assert.equal(doc.frontMatter.data.entries, '1');
  assert.equal(doc.frontMatter.data.session_id, SESSION.sessionId);
  assert.equal(Number(doc.frontMatter.data.index_tokens_est), indexTokensEst);
  assert.ok(doc.indexSection, '索引区块必须存在');
  assert.equal(doc.indexSection.rows.length, 1);
  assert.equal(doc.indexSection.rows[0].id, entryId);
});

test('buildMemoryFileText: 条目字段齐全且时间合法', () => {
  const { text } = buildFixture();
  const entry = parseMemoryFile(text).entries[0];
  for (const key of ['type', 'event_time', 'recorded_at', 'updated_at', 'timezone', 'time_source', 'confidence', 'privacy', 'status', 'tags', 'seq']) {
    assert.ok(entry.fieldMap[key] !== undefined, `缺字段 ${key}`);
  }
  assert.equal(entry.fieldMap.type, 'session_digest');
  assert.equal(entry.fieldMap.summary_model, 'local-extractive');
  assert.equal(entry.fieldMap.time_source, 'system_clock');
});

test('buildMemoryFileText: 正文含要点与可回收的增量区块', () => {
  const { text } = buildFixture();
  const entry = parseMemoryFile(text).entries[0];
  const body = entry.bodyLines.join('\n');
  assert.ok(body.includes('要点：'));
  assert.ok(body.includes(PURGE_HEADING));
  assert.ok(body.includes('本地') || body.includes('工作记忆'), body);
  assert.ok(entry.blocks.some((block) => block.tag === 'note'));
});

test('buildMemoryFileText: 写出去再读回来逐字节一致', () => {
  const { text } = buildFixture();
  assert.equal(serializeMemoryFile(parseMemoryFile(text)), text);
});

test('purgeRegion: 只覆盖增量区块', () => {
  const { text } = buildFixture();
  const entry = parseMemoryFile(text).entries[0];
  const region = purgeRegion(entry.bodyLines);
  assert.ok(region);
  assert.equal(entry.bodyLines[region.start], PURGE_HEADING);
  const removed = entry.bodyLines.slice(region.start, region.end);
  assert.ok(removed.length > 1);
  assert.ok(!removed.some((line) => line.includes('权威内容')), '不得把指针区块算进回收范围');
});

test('buildMemoryFileText: 无可抽取要点时不编造内容', () => {
  const digest = extractDigest([], {});
  const { text } = buildMemoryFileText({
    digest,
    session: { ...SESSION, messageRange: '0-0', coversFrom: 'unknown', coversTo: 'unknown' },
    stamp: '2026-10-23_160000',
    savedAt: '2026-10-23T16:00:00+08:00',
    timezone: 'Asia/Shanghai',
    memoryClass: 'chat',
    fileName: '2026-10-23_160000.md',
  });
  assert.ok(text.includes('无可抽取要点'));
  assert.equal(parseMemoryFile(text).issues.length, 0);
});

test('索引行: 不得出现 undefined 字段', () => {
  const { text } = buildFixture();
  const doc = parseMemoryFile(text);
  assert.ok(!text.includes('undefined'), '索引里出现 undefined 说明 fieldMap 没建好');
  assert.equal(doc.indexSection.rows.length, 1);
  assert.ok(doc.indexSection.rows[0].rest.includes('event_time=2026-10-23T15:40:00+08:00'));
});

test('要点只放高分几条，增量区块保留全部', () => {
  const many = [];
  for (let i = 0; i < 12; i += 1) {
    many.push({ role: 'user', text: `第 ${i} 次确认：决定采用方案 ${i}，必须保留这条约束。` });
    many.push({ role: 'assistant', text: `第 ${i} 次回复，继续下一步。` });
  }
  const digest = extractDigest(many, { charBudget: 2000 });
  const { text } = buildMemoryFileText({
    digest,
    session: { ...SESSION, messageRange: '1-24' },
    stamp: '2026-10-23_170000',
    savedAt: '2026-10-23T17:00:00+08:00',
    timezone: 'Asia/Shanghai',
    memoryClass: 'chat',
    fileName: '2026-10-23_170000.md',
  });
  const entry = parseMemoryFile(text).entries[0];
  const body = entry.bodyLines;
  const pointsStart = body.findIndex((line) => /^要点[:：]/.test(line));
  const purgeStart = body.findIndex((line) => line === PURGE_HEADING);
  const points = body.slice(pointsStart + 1, purgeStart).filter((line) => line.startsWith('- ['));
  const detail = body.slice(purgeStart + 1).filter((line) => /^- \d{4}-/.test(line));
  assert.ok(points.length > 0 && points.length <= 6, `要点条数 ${points.length}`);
  assert.ok(detail.length > points.length, `增量 ${detail.length} 条应多于要点 ${points.length} 条`);
});

test('sanitizeUserText: 去掉宿主注入的运行时上下文', () => {
  const raw = [
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    '',
    'Current DSH file policy: workspace-write. Approval policy: ask.',
    'Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:1234".',
    '',
    '把摘要改成纯本地抽取。',
    '',
    '<system-reminder>',
    'Time sampled while preparing turn 1, step 1: 2026-10-23T15:00:00+08:00',
    '</system-reminder>',
  ].join('\n');
  const clean = sanitizeUserText(raw);
  assert.equal(clean, '把摘要改成纯本地抽取。');
});

test('extractMessages: 用户消息里的注入内容不会进入摘要', () => {
  const events = [{
    type: 'user/message', seq: 1, time: 1100, surfaceOp: 'append',
    data: { content: [{ type: 'text', text: 'Current runtime context. blah\n\n决定：改成 B 方案。\n\n<system-reminder>noise</system-reminder>' }] },
  }];
  const messages = extractMessages(events, toIso);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '决定：改成 B 方案。');
});

process.exitCode = report() > 0 ? 1 : 0;
