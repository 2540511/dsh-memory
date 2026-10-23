import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { parseMemoryFile, serializeMemoryFile } from '../src/format.js';
import {
  buildTurns,
  buildWorkEntries,
  buildDiffEntries,
  packVolumes,
  buildWorkFileText,
} from '../src/workmem.js';

const { test, report } = createSuite('workmem');

const MESSAGES = [
  { role: 'user', text: '把摘要改成纯本地抽取。\n第二行也要原样保留。', time: '2026-10-23T15:00:00+08:00', seq: 1 },
  { role: 'assistant', text: '好的，我改成抽取式。', time: '2026-10-23T15:01:00+08:00', seq: 2 },
  { role: 'tool', text: 'exit code 1', time: '2026-10-23T15:01:30+08:00', seq: 3 },
  { role: 'user', text: '## 这个标题不能被当成条目边界', time: '2026-10-23T15:02:00+08:00', seq: 4 },
  { role: 'assistant', text: '收到。', time: '2026-10-23T15:02:10+08:00', seq: 5 },
];

test('buildTurns: 按用户发言切轮，助手与工具归入当前轮', () => {
  const turns = buildTurns(MESSAGES);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].messages.length, 3);
  assert.equal(turns[1].messages.length, 2);
});

const INPUT = {
  messages: MESSAGES,
  savedAt: '2026-10-23T15:10:00+08:00',
  timezone: 'Asia/Shanghai',
  stamp: '2026-10-23_151000',
};

test('buildWorkEntries: 一轮一条，逐字保留原文', () => {
  const entries = buildWorkEntries(INPUT);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].fieldMap.type, 'work_record');
  assert.equal(entries[0].fieldMap.verbatim, 'true');
  assert.equal(entries[0].fieldMap.purge_after, 'never');
  assert.equal(entries[0].fieldMap.conflict_policy, 'manual');
  assert.equal(entries[0].fieldMap.weight_exempt, 'true');
  const body = entries[0].bodyLines.join('\n');
  assert.ok(body.includes('第二行也要原样保留。'), '多行原文必须逐字保留');
  assert.ok(body.includes('工具'));
});

test('buildWorkEntries: 正文里的 ## 不会破坏条目边界', () => {
  const entries = buildWorkEntries(INPUT);
  const doc = buildWorkFileText({
    session: { sessionId: 's1', title: '工作会话', messageRange: '1-5' },
    entries,
    savedAt: INPUT.savedAt,
    stamp: INPUT.stamp,
    timezone: 'Asia/Shanghai',
  });
  const parsed = parseMemoryFile(doc.text);
  assert.equal(parsed.issues.length, 0, JSON.stringify(parsed.issues));
  assert.equal(parsed.entries.length, 2, '两个条目，且正文里的 ## 没被当成新条目');
  assert.ok(parsed.entries[1].bodyLines.join('\n').includes('## 这个标题不能被当成条目边界'));
});

test('buildWorkFileText: 索引标注不作为权威、front matter 标 work', () => {
  const entries = buildWorkEntries(INPUT);
  const { text } = buildWorkFileText({
    session: { sessionId: 's1', title: '工作会话', messageRange: '1-5' },
    entries,
    savedAt: INPUT.savedAt,
    stamp: INPUT.stamp,
    timezone: 'Asia/Shanghai',
    part: 1,
    totalParts: 2,
  });
  const doc = parseMemoryFile(text);
  assert.equal(doc.frontMatter.data.memory_class, 'work');
  assert.equal(doc.frontMatter.data.summary_authoritative, 'false');
  assert.equal(doc.frontMatter.data.part, '1');
  assert.equal(doc.frontMatter.data.total_parts, '2');
  assert.ok(doc.indexSection, '要有索引区块');
  assert.ok(!text.includes('要点：'), '工作记忆不生成摘要正文');
});

test('buildWorkFileText: 写出再读回逐字节一致', () => {
  const entries = buildWorkEntries(INPUT);
  const { text } = buildWorkFileText({
    session: { sessionId: 's1', title: '工作会话', messageRange: '1-5' },
    entries,
    savedAt: INPUT.savedAt,
    stamp: INPUT.stamp,
    timezone: 'Asia/Shanghai',
  });
  assert.equal(serializeMemoryFile(parseMemoryFile(text)), text);
});

test('packVolumes: 按行数分卷，条目不被拆开', () => {
  const entries = buildWorkEntries(INPUT);
  const volumes = packVolumes(entries, { maxLines: 20, maxBytes: 1024 * 1024 });
  assert.ok(volumes.length >= 2);
  const flat = volumes.flatMap((volume) => volume.entries.map((item) => item.entry.id));
  assert.deepEqual(flat, entries.map((entry) => entry.id));
  for (const volume of volumes) {
    assert.ok(volume.lines <= 20 + 30, `单卷行数 ${volume.lines} 超限`);
  }
});

test('buildDiffEntries: 一个文件一条，正文是 hunk 原文', () => {
  const entries = buildDiffEntries({
    diffs: [{
      kind: 'text',
      path: 'src/a.js',
      display: 'src/a.js',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new1', '+new2'] }],
      added: 2,
      deleted: 1,
      eventTime: '2026-10-23T15:05:00+08:00',
    }],
    savedAt: INPUT.savedAt,
    timezone: 'Asia/Shanghai',
    stamp: INPUT.stamp,
    seqStart: 3,
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fieldMap.type, 'work_diff');
  assert.equal(entries[0].fieldMap.evidence_kind, 'diff');
  assert.equal(entries[0].fieldMap.file_path, 'src/a.js');
  assert.equal(entries[0].fieldMap.seq, '3');
  assert.ok(entries[0].bodyLines.join('\n').includes('+new2'));
});

test('buildDiffEntries: 二进制文件只记路径不编造内容', () => {
  const entries = buildDiffEntries({
    diffs: [{ kind: 'binary', path: 'img.png', display: 'img.png' }],
    savedAt: INPUT.savedAt,
    timezone: 'Asia/Shanghai',
    stamp: INPUT.stamp,
    seqStart: 1,
  });
  const body = entries[0].bodyLines.join('\n');
  assert.ok(body.includes('无法比较'));
  assert.ok(!body.includes('@@'));
});

process.exitCode = report() > 0 ? 1 : 0;
