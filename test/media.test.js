import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { parseMemoryFile } from '../src/format.js';
import { extractMediaFromEvents, buildMediaEntries, applyDescription } from '../src/media.js';

const { test, report } = createSuite('media');

const EVENTS = [
  {
    type: 'user/message', seq: 1, time: '2026-10-23T16:30:00+08:00',
    data: { content: [
      { type: 'text', text: '看这张图' },
      { type: 'image', attachment: { attachmentId: 'att_1', mediaType: 'image/png', bytes: 2048, width: 200, height: 100, name: 'shot.png' } },
    ] },
  },
  {
    type: 'user/message', seq: 2, time: '2026-10-23T16:31:00+08:00',
    data: { content: [
      { type: 'file', attachment: { attachmentId: 'att_2', name: 'report.pdf', bytes: 900 } },
    ] },
  },
  {
    type: 'assistant/message', seq: 3, time: '2026-10-23T16:32:00+08:00',
    data: { message: { content: [{ type: 'text', text: '收到' }] } },
  },
];

test('extractMediaFromEvents: 找出图片与文件，忽略纯文本', () => {
  const items = extractMediaFromEvents(EVENTS);
  assert.equal(items.length, 2);
  assert.equal(items[0].mediaType, 'image');
  assert.equal(items[0].mediaSource, 'att_1');
  assert.equal(items[0].width, 200);
  assert.equal(items[1].mediaType, 'file');
  assert.equal(items[1].name, 'report.pdf');
});

test('extractMediaFromEvents: 同一附件只记一次', () => {
  const duplicated = [...EVENTS, EVENTS[0]];
  assert.equal(extractMediaFromEvents(duplicated).length, 2);
});

test('buildMediaEntries: media_retained 恒为 false，默认 pending', () => {
  const entries = buildMediaEntries(extractMediaFromEvents(EVENTS), {
    savedAt: '2026-10-23T16:35:00+08:00',
    timezone: 'Asia/Shanghai',
    stamp: '2026-10-23_163500',
    seqStart: 7,
  });
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.fieldMap.type, 'media_summary');
    assert.equal(entry.fieldMap.media_retained, 'false');
    assert.equal(entry.fieldMap.media_desc_status, 'pending');
    assert.equal(entry.fieldMap.status, 'pending');
    assert.equal(entry.fieldMap.purge_after, 'never');
  }
  assert.deepEqual(entries.map((entry) => Number(entry.fieldMap.seq)), [7, 8]);
  assert.ok(entries[0].bodyLines.join('\n').includes('未保存'));
});

test('buildMediaEntries: 条目能被格式层解析', () => {
  const entries = buildMediaEntries(extractMediaFromEvents(EVENTS), {
    savedAt: '2026-10-23T16:35:00+08:00', timezone: 'Asia/Shanghai', stamp: '2026-10-23_163500', seqStart: 1,
  });
  const text = [
    '---', 'memory_format: dsh-memory', 'format_version: 1', 'saved_at: 2026-10-23T16:35:00+08:00', '---', '',
    ...entries.map((entry) => [
      `## [${entry.id}] ${entry.title}`, '',
      ...entry.fields.map((field) => `- ${field.key}: ${field.value}`), '',
      ...entry.bodyLines, '',
    ].join('\n')),
  ].join('\n');
  const doc = parseMemoryFile(text);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
  assert.equal(doc.entries.length, 2);
  assert.ok(doc.entries[0].blocks.some((block) => block.tag === 'media'));
});

test('applyDescription: 填描述后转 current，并记录模型', () => {
  const [entry] = buildMediaEntries(extractMediaFromEvents(EVENTS), {
    savedAt: '2026-10-23T16:35:00+08:00', timezone: 'Asia/Shanghai', stamp: '2026-10-23_163500', seqStart: 1,
  });
  entry.fields = [
    { key: 'status', value: 'pending' },
    { key: 'media_desc_status', value: 'pending' },
    { key: 'media_desc_model', value: 'none' },
    { key: 'updated_at', value: '2026-10-23T16:35:00+08:00' },
  ];
  applyDescription(entry, '一张 200x100 的截图，标题栏写着「记忆」。', {
    model: 'deepseek-flash', at: '2026-10-23T16:40:00+08:00',
  });
  assert.equal(entry.fieldMap.status, 'current');
  assert.equal(entry.fieldMap.media_desc_status, 'current');
  assert.equal(entry.fieldMap.media_desc_model, 'deepseek-flash');
  assert.ok(entry.bodyLines[0].includes('截图'));
  assert.ok(entry.bodyLines.join('\n').includes('不能还原文件'));
});

test('applyDescription: 空描述拒绝', () => {
  const [entry] = buildMediaEntries([{ mediaType: 'image', mediaSource: 'a', time: null }], {
    savedAt: 'x', timezone: 'Asia/Shanghai', stamp: 's', seqStart: 1,
  });
  assert.throws(() => applyDescription(entry, '   '), /描述为空/);
});

test('buildMediaEntries: 毫秒时间戳必须转成 ISO 8601', () => {
  const [entry] = buildMediaEntries(
    [{ mediaType: 'image', mediaSource: 'a1', time: 1792743981554 }],
    {
      savedAt: '2026-10-23T16:35:00+08:00', timezone: 'Asia/Shanghai', stamp: 's', seqStart: 1,
      toIso: (ms) => new Date(ms).toISOString().replace('Z', '+00:00'),
    },
  );
  assert.match(entry.fieldMap.event_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.ok(!/^\d+$/.test(entry.fieldMap.event_time), '不能直接写毫秒数');
});

process.exitCode = report() > 0 ? 1 : 0;
