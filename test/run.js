/**
 * P1 格式层 + B 抽取器 的离线自测。
 * 运行: node test/run.js
 * 全部用 node:assert, 无第三方依赖。
 */
import assert from 'node:assert/strict';
import {
  parseMemoryFile,
  serializeMemoryFile,
  setEntryField,
  setEntryBody,
  describe,
  escapeBodyLines,
  unescapeBodyLines,
  estimateTokens,
} from '../src/format.js';
import { extractDigest, assertExtractive, splitSpans, normalizeMessages, isUsableSpan } from '../src/extract.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, error });
  }
}

// ---------------------------------------------------------------- fixture

const FIXTURE = String.raw`---
memory_format: dsh-memory
format_version: 1
saved_at: 2026-10-22T22:15:30+08:00
session_name: memory-plugin-design
session_id: sess_9f2c
message_range: 1-58
summary_model: local-extractive
entries: 2
x_unknown_front: keepme
---

## 记忆索引

> 索引仅用于快速定位，权威内容以条目正文为准。

- M-20261022-01: 摘要方案改为本地抽取。event_time=2026-10-22T21:40:12+08:00 status=current
- M-20261022-02: 记忆根目录在工作区。event_time=2026-10-22T21:52:00+08:00 status=current

## [M-20261022-01] 摘要方案改为本地抽取

- type: decision
- event_time: 2026-10-22T21:40:12+08:00
- recorded_at: 2026-10-22T22:15:30+08:00
- updated_at: 2026-10-22T22:15:30+08:00
- timezone: Asia/Shanghai
- time_source: system_clock
- confidence: 0.9
- privacy: device_local
- status: current
- tags: plugin, memory
- seq: 1
- x_unknown_field: must-keep

用户要求摘要方案从 C 改为 B。
正文里这一行是转义的条目边界：
\## [fake] not-an-entry
继续普通段落。

> [!conflict] 早期版本写的是云端生成，已被本条目取代。

## [M-20261022-02] 记忆根目录

- type: preference
- event_time: 2026-10-22T21:52:00+08:00
- recorded_at: 2026-10-22T22:15:30+08:00
- updated_at: 2026-10-22T22:15:30+08:00
- timezone: Asia/Shanghai
- time_source: user_specified
- confidence: 0.95
- privacy: device_local
- status: current
- tags: storage
- seq: 2

记忆统一保存在工作区下的记忆目录。
`;

// ---------------------------------------------------------------- format

test('parse: 条目切分正确, 索引区不被当成条目', () => {
  const doc = parseMemoryFile(FIXTURE);
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.entries[0].id, 'M-20261022-01');
  assert.equal(doc.entries[0].title, '摘要方案改为本地抽取');
  assert.equal(doc.entries[1].id, 'M-20261022-02');
  assert.ok(doc.indexSection, 'index section should be detected');
  assert.equal(doc.indexSection.rows.length, 2);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
});

test('parse: 未知 front matter 与未知字段保留', () => {
  const doc = parseMemoryFile(FIXTURE);
  assert.equal(doc.frontMatter.data.x_unknown_front, 'keepme');
  assert.equal(doc.entries[0].fieldMap.x_unknown_field, 'must-keep');
});

test('parse: 正文里转义的 ## 不产生第三条目', () => {
  const doc = parseMemoryFile(FIXTURE);
  const body = doc.entries[0].bodyLines.join('\n');
  assert.ok(body.includes('## [fake] not-an-entry'), 'escaped heading should be unescaped in body');
  assert.equal(doc.entries.length, 2);
});

test('parse: 引用块被识别且原文保留', () => {
  const doc = parseMemoryFile(FIXTURE);
  const block = doc.entries[0].blocks[0];
  assert.equal(block.tag, 'conflict');
  assert.ok(block.text.includes('云端生成'));
});

test('round-trip: 未修改时逐字节一致', () => {
  const doc = parseMemoryFile(FIXTURE);
  assert.equal(serializeMemoryFile(doc), FIXTURE);
});

test('round-trip: CRLF 文件保持一致', () => {
  const crlf = FIXTURE.replace(/\n/g, '\r\n');
  const doc = parseMemoryFile(crlf);
  assert.equal(doc.eol, '\r\n');
  assert.equal(serializeMemoryFile(doc), crlf);
});

test('edit: 只改目标条目, 其余字节不变', () => {
  const doc = parseMemoryFile(FIXTURE);
  setEntryField(doc.entries[0], 'status', 'superseded');
  const out = serializeMemoryFile(doc);
  assert.ok(out.includes('- status: superseded'));
  assert.ok(out.includes('## [M-20261022-02] 记忆根目录'));
  assert.ok(out.includes('\\## [fake] not-an-entry'), 'body escaping must survive rewrite');
  assert.ok(out.includes('x_unknown_field: must-keep'), 'unknown field must survive rewrite');
  const reparsed = parseMemoryFile(out);
  assert.equal(reparsed.entries.length, 2);
  assert.equal(reparsed.entries[0].fieldMap.status, 'superseded');
  assert.equal(reparsed.issues.length, 0);
});

test('edit: 写正文时自动转义条目边界', () => {
  const doc = parseMemoryFile(FIXTURE);
  setEntryBody(doc.entries[1], ['新正文', '## [注入] 危险标题', '结尾']);
  const out = serializeMemoryFile(doc);
  const reparsed = parseMemoryFile(out);
  assert.equal(reparsed.entries.length, 2, 'body heading must not create an entry');
  assert.ok(reparsed.entries[1].bodyLines.includes('## [注入] 危险标题'));
});

test('escape/unescape 互逆', () => {
  const lines = ['## a', '# b', '普通', ' ## 缩进'];
  assert.deepEqual(unescapeBodyLines(escapeBodyLines(lines)), lines);
});

test('validate: 缺字段/时间倒退/seq 乱序都能报出来', () => {
  const bad = String.raw`---
memory_format: dsh-memory
format_version: 1
saved_at: 2026-10-22T22:15:30+08:00
---

## [BAD-1] 缺一堆字段

- type: fact
- event_time: unknown
- recorded_at: 2026-10-22T22:15:30+08:00
- updated_at: 2026-10-22T20:00:00+08:00
- seq: 5

## [BAD-2] seq 倒退

- type: fact
- event_time: 2026-10-22T21:00:00+08:00
- recorded_at: 2026-10-22T22:15:30+08:00
- updated_at: 2026-10-22T22:15:30+08:00
- timezone: Asia/Shanghai
- time_source: system_clock
- confidence: 0.5
- privacy: device_local
- status: current
- tags: t
- seq: 3
`;
  const doc = parseMemoryFile(bad);
  const codes = doc.issues.map((issue) => issue.code);
  assert.ok(codes.includes('ENTRY_MISSING_FIELDS'));
  assert.ok(codes.includes('TIME_ANOMALY'));
  assert.ok(codes.includes('SEQ_NOT_MONOTONIC'));
});

test('validate: 时间格式与 time_source 一致性', () => {
  const doc = parseMemoryFile(String.raw`---
memory_format: dsh-memory
---

## [T-1] bad time

- type: fact
- event_time: 2026-10-22 21:00
- recorded_at: 2026-10-22T22:15:30+08:00
- updated_at: 2026-10-22T22:15:30+08:00
- timezone: Asia/Shanghai
- time_source: unknown
- confidence: 0.5
- privacy: device_local
- status: current
- tags: t
- seq: 1
`);
  const codes = doc.issues.map((issue) => issue.code);
  assert.ok(codes.includes('TIME_FORMAT'));
  assert.ok(codes.includes('TIME_SOURCE_MISMATCH'));
  assert.ok(codes.includes('FM_MISSING_KEY'));
});

test('describe: 类型统计与 token 估算', () => {
  const doc = parseMemoryFile(FIXTURE);
  const info = describe(doc);
  assert.equal(info.entries, 2);
  assert.equal(info.types.decision, 1);
  assert.equal(info.types.preference, 1);
  assert.ok(info.tokensEst > 0);
  assert.ok(estimateTokens('中文五个字') > 0);
});

// ---------------------------------------------------------------- extract

const CHAT = [
  { role: 'user', text: '我想把摘要方案从云端改成纯本地抽取，别再发到外网了。', time: '2026-10-22T21:40:12+08:00', seq: 1 },
  { role: 'assistant', text: '好的，那我按本地抽取重写。需要注意的是抽取式摘要只能选句子，不能改写。', time: '2026-10-22T21:41:00+08:00', seq: 2 },
  { role: 'user', text: '工作记忆必须完全详细保存，diff 要单独生成。', time: '2026-10-22T21:52:00+08:00', seq: 3 },
  { role: 'assistant', text: '明白。20 天后回收增量明细，源文件永久保留。', time: '2026-10-22T21:53:00+08:00', seq: 4 },
  { role: 'tool', text: 'npm test 退出码 1，3 个用例失败。', time: '2026-10-22T21:55:00+08:00', seq: 5 },
  { role: 'user', text: '这个先待确认，明天再看。', time: '2026-10-22T21:56:00+08:00', seq: 6 },
];

test('extract: 所有输出都是原文子串 (零编造)', () => {
  const result = extractDigest(CHAT, { charBudget: 400 });
  assert.deepEqual(assertExtractive(result, CHAT), []);
});

test('extract: 抓住决策/约束/未决/故障', () => {
  const result = extractDigest(CHAT, { charBudget: 600 });
  const kinds = new Set(result.increments.map((item) => item.kind));
  assert.ok(kinds.has('decision'), `kinds=${[...kinds]}`);
  assert.ok(kinds.has('constraint'), `kinds=${[...kinds]}`);
  assert.ok(kinds.has('open'), `kinds=${[...kinds]}`);
  assert.ok(kinds.has('failure'), `kinds=${[...kinds]}`);
});

test('extract: 遵守字符预算', () => {
  const result = extractDigest(CHAT, { charBudget: 120 });
  const used = result.increments.reduce((sum, item) => sum + item.quote.length, 0);
  assert.ok(used <= 120, `used=${used}`);
  assert.ok(result.increments.length >= 1);
});

test('extract: 承接行去重且不冒充本会话原文', () => {
  const previousDigest = '上一条摘要正文：用户要求记忆只存工作区。';
  const result = extractDigest(CHAT, {
    charBudget: 600,
    carried: ['工作记忆必须完全详细保存，diff 要单独生成。', '用户要求记忆只存工作区。'],
  });
  assert.equal(result.carried.length, 1, '已在本次增量里出现的承接行应被去掉');
  assert.deepEqual(assertExtractive(result, CHAT, { carriedPool: previousDigest }), []);
  const withoutPool = assertExtractive(result, CHAT);
  assert.ok(withoutPool.some((item) => item.where === 'carried'), '未提供 carriedPool 必须报出来');
});

test('extract: 长会话能真正压缩, 且保留用户锚点句', () => {
  const long = [];
  for (let i = 0; i < 30; i += 1) {
    long.push({ role: 'user', text: `第 ${i} 轮我想确认一下这个流程是不是还有遗漏的地方，顺便看看日志。` });
    long.push({ role: 'assistant', text: `第 ${i} 轮我查了日志，看起来没有问题，继续下一步。` });
  }
  long.push({ role: 'user', text: '最终决定：把重量阈值定成 0.85，别再改了。' });
  const result = extractDigest(long, { charBudget: 500 });
  assert.deepEqual(assertExtractive(result, long), []);
  const sourceChars = long.reduce((sum, m) => sum + m.text.length, 0);
  assert.ok(result.stats.summaryChars < sourceChars * 0.25, `ratio=${result.stats.ratio}`);
  assert.ok(result.summaryText.includes('最终决定'), '关键决策句不能被压掉');
  const firstUserAnchor = result.increments.filter((item) => item.speaker === 'user');
  assert.ok(firstUserAnchor.length >= 1);
});

test('extract: 输出里出现的数字都能在原文找到', () => {
  const result = extractDigest(CHAT, { charBudget: 800 });
  const pool = CHAT.map((m) => m.text).join('\n');
  for (const item of result.increments) {
    for (const number of item.quote.match(/\d+(?:\.\d+)?/g) || []) {
      assert.ok(pool.includes(number), `invented number: ${number}`);
    }
  }
});

test('extract: 超长句按逗号切开仍是子串', () => {
  const long = '这是一段很长的说明，'.repeat(20) + '结束。';
  const messages = [{ role: 'user', text: long }];
  const spans = splitSpans(long, 120);
  for (const span of spans) assert.ok(long.includes(span.text));
  const result = extractDigest(messages, { charBudget: 300 });
  assert.deepEqual(assertExtractive(result, messages), []);
});

test('extract: 空输入不崩且明确无要点', () => {
  const result = extractDigest([], {});
  assert.equal(result.increments.length, 0);
  assert.ok(result.summaryText.includes('无可抽取要点'));
});

test('normalizeMessages: 兼容 content blocks 与空白', () => {
  const units = normalizeMessages([
    { role: 'user', content: [{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }] },
    { role: 'assistant', text: '   ' },
    null,
  ]);
  assert.equal(units.length, 1);
  assert.equal(units[0].text, '甲\n乙');
});

// ---------------------------------------------------------------- report

test('splitSpans: 多段落消息逐段切句，不再整段当一句', () => {
  const text = '第一段的第一句。第一段的第二句。\n\n第二段只有一句。\n\n第三段。';
  const spans = splitSpans(text, 200);
  for (const span of spans) {
    assert.ok(!span.text.includes('\n\n'), `span 跨了段落: ${JSON.stringify(span.text)}`);
    assert.ok(text.includes(span.text));
  }
  assert.ok(spans.length >= 4, `spans=${spans.length}`);
});

test('isUsableSpan: 拒收残句与表格行', () => {
  assert.equal(isUsableSpan('）以及 secret 级是否拒绝入盘？'), false);
  assert.equal(isUsableSpan('| 方案 | 后果 |'), false);
  assert.equal(isUsableSpan('- '), false);
  assert.equal(isUsableSpan('决定：改成 B 方案。'), true);
});

test('extract: 摘要里不出现列表符号与开引号', () => {
  const messages = [{
    role: 'assistant',
    text: '- **状态全在本地**：`{dataRoot}/.qqbot/` 是明文 jsonl，默认留 7 天。\n”privacy 取值待定。\n1. 先确认默认值。\n',
  }];
  const result = extractDigest(messages, { charBudget: 500 });
  for (const item of result.increments) {
    const quote = item.quote.trim();
    assert.ok(!/^[-*+]\s/.test(quote), `列表符号: ${quote}`);
    assert.ok(!/^\d+[.)]\s/.test(quote), `编号: ${quote}`);
    assert.ok(!/^”/.test(quote), `开引号残句: ${quote}`);
  }
});

test('extract: 摘要里不出现残句开头与表格行', () => {
  const messages = [{
    role: 'user',
    text: [
      '问题一：privacy 取什么值（normal/private/secret？',
      '）以及要不要 public？',
      '',
      '| 方案 | 后果 |',
      '| A | 拒绝写入 |',
      '',
      '决定：只存 normal 与 private，secret 拒绝入盘。',
    ].join('\n'),
  }];
  const result = extractDigest(messages, { charBudget: 500 });
  for (const item of result.increments) {
    const quote = item.quote.trim();
    assert.ok(!/^[）)\]]/.test(quote), `残句: ${quote}`);
    assert.ok(!quote.startsWith('|'), `表格行: ${quote}`);
  }
  assert.ok(result.summaryText.includes('secret 拒绝入盘'));
});

console.log(`\npassed: ${passed}, failed: ${failures.length}`);
for (const failure of failures) {
  console.log(`\nFAIL: ${failure.name}`);
  console.log(String(failure.error && failure.error.stack ? failure.error.stack : failure.error).split('\n').slice(0, 5).join('\n'));
}
if (failures.length > 0) process.exitCode = 1;
else console.log('all good');
