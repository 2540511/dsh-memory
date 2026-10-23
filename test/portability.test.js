import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { parseMemoryFile, serializeMemoryFile } from '../src/format.js';
import { extractDigest } from '../src/extract.js';
import { buildMemoryFileText } from '../src/compose.js';
import {
  selectEntries, buildExportDocument, planImport, fingerprint,
  buildImportFileText, renderAuditEntry,
} from '../src/portability.js';

const { test, report } = createSuite('portability');

function makeDoc(file, id, fields, body = '正文内容。') {
  return {
    file,
    entry: {
      id,
      title: `条目 ${id}`,
      fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
      fieldMap: { ...fields },
      bodyLines: [body],
      blocks: [],
    },
  };
}

const BASE_FIELDS = {
  type: 'fact',
  event_time: '2026-10-20T10:00:00+08:00',
  recorded_at: '2026-10-20T10:00:00+08:00',
  updated_at: '2026-10-20T10:00:00+08:00',
  timezone: 'Asia/Shanghai',
  time_source: 'system_clock',
  confidence: '0.9',
  privacy: 'device_local',
  status: 'current',
  tags: 'alpha, beta',
  seq: '1',
};

const DOCS = [
  makeDoc('a.md', 'M-1', BASE_FIELDS, '记忆根目录在工作区下。'),
  makeDoc('b.md', 'M-2', { ...BASE_FIELDS, type: 'preference', tags: 'alpha', seq: '2' }, '偏好用本地抽取。'),
  makeDoc('c.md', 'M-3', { ...BASE_FIELDS, privacy: 'secret', seq: '3' }, '不该导出的秘密。'),
];

test('selectEntries: 按类型 / 标签 / 单条 / 时间筛选，secret 一律排除', () => {
  assert.deepEqual(selectEntries(DOCS, { kind: 'all' }).length, 2);
  assert.deepEqual(selectEntries(DOCS, { kind: 'type', value: 'preference' }).map((d) => d.entry.id), ['M-2']);
  assert.deepEqual(selectEntries(DOCS, { kind: 'tag', value: 'beta' }).map((d) => d.entry.id), ['M-1']);
  assert.deepEqual(selectEntries(DOCS, { kind: 'id', value: 'M-2' }).map((d) => d.entry.id), ['M-2']);
  assert.equal(selectEntries(DOCS, { kind: 'time', from: '2026-10-21T00:00:00+08:00' }).length, 0);
});

const EXPORT = buildExportDocument(selectEntries(DOCS, { kind: 'all' }), {
  exportedAt: '2026-10-23T16:00:00+08:00',
  scopeLabel: 'all',
});

test('buildExportDocument: 自包含、可被格式层解析、不含 secret', () => {
  const doc = parseMemoryFile(EXPORT.text);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.frontMatter.data.exported_at, '2026-10-23T16:00:00+08:00');
  assert.equal(doc.frontMatter.data.entries, '2');
  assert.ok(!EXPORT.text.includes('不该导出的秘密'));
});

test('buildExportDocument: 写出再读回逐字节一致', () => {
  assert.equal(serializeMemoryFile(parseMemoryFile(EXPORT.text)), EXPORT.text);
});

test('planImport: 正常导入全部接受', () => {
  const parsed = parseMemoryFile(EXPORT.text);
  const result = planImport(parsed, { existingIds: new Set() });
  assert.equal(result.ok, true);
  assert.equal(result.report.accepted, 2);
  assert.equal(result.report.conflicts, 0);
});

test('planImport: 同 ID 同内容跳过，同 ID 不同内容标冲突', () => {
  const parsed = parseMemoryFile(EXPORT.text);
  const dup = planImport(parsed, { existingIds: new Set(['M-1']) });
  assert.equal(dup.report.conflicts, 1, 'M-1 存在但指纹未知，按冲突处理');
  assert.equal(dup.report.accepted, 1);

  const fp = fingerprint(parsed.entries[0]);
  const same = planImport(parsed, { existingIds: new Set(['M-1']), existingFingerprints: new Map([['M-1', fp]]) });
  assert.equal(same.report.skipped, 1);
  assert.equal(same.report.conflicts, 0);
});

test('planImport: 版本不符直接拒绝', () => {
  const bad = parseMemoryFile('---\nmemory_format: dsh-memory\nformat_version: 2\n---\n');
  const result = planImport(bad, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /版本不兼容/);
});

test('planImport: 缺字段的条目被拒绝并报告', () => {
  const text = EXPORT.text.replace('- timezone: Asia/Shanghai\n', '');
  const parsed = parseMemoryFile(text);
  const result = planImport(parsed, {});
  assert.equal(result.ok, true);
  assert.ok(result.report.failed >= 1);
  assert.ok(result.report.missingFields.some((item) => item.fields.includes('timezone')));
});

test('planImport: seq 冲突时重排并标记 seq_reassigned', () => {
  const parsed = parseMemoryFile(EXPORT.text);
  for (const entry of parsed.entries) entry.fieldMap.seq = '1';
  parsed.entries[0].fields.find((field) => field.key === 'seq').value = '1';
  parsed.entries[1].fields.find((field) => field.key === 'seq').value = '1';
  const result = planImport(parsed, {});
  assert.equal(result.report.seqReassigned, true);
  const accepted = result.plan.filter((item) => item.action === 'accept');
  assert.deepEqual(accepted.map((item) => item.entry.fieldMap.seq), ['1', '2']);
  assert.ok(accepted[0].entry.fields.some((field) => field.key === 'seq_reassigned'));
});

test('buildImportFileText: 导入结果可被再次解析', () => {
  const parsed = parseMemoryFile(EXPORT.text);
  const result = planImport(parsed, {});
  const accepted = result.plan.filter((item) => item.action === 'accept').map((item) => item.entry);
  const text = buildImportFileText(accepted, { at: '2026-10-23T16:00:00+08:00', source: 'upload' });
  const doc = parseMemoryFile(text);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.frontMatter.data.imported, 'true');
});

test('renderAuditEntry: 与记忆条目同构，含时间/来源/操作者/结果', () => {
  const text = renderAuditEntry({
    op: 'export', at: '2026-10-23T16:00:00+08:00', actor: 'user',
    result: 'ok', entries: 2, source: 'local', detail: 'scope=all',
  });
  assert.ok(text.startsWith('## [AUDIT-'));
  assert.ok(text.includes('- op: export'));
  assert.ok(text.includes('- entries: 2'));
  assert.ok(text.includes('- actor: user'));
});

test('往返：真实聊天记忆导出后能原样导入', () => {
  const digest = extractDigest([{ role: 'user', text: '决定：用本地抽取。' }], {});
  const built = buildMemoryFileText({
    digest,
    session: { sessionId: 's1', title: 't', messageRange: '1-1', coversFrom: 'unknown', coversTo: '2026-10-23T16:00:00+08:00' },
    stamp: '2026-10-23_160000',
    savedAt: '2026-10-23T16:00:00+08:00',
    timezone: 'Asia/Shanghai',
    memoryClass: 'chat',
    fileName: '2026-10-23_160000.md',
  });
  const parsed = parseMemoryFile(built.text);
  const docs = parsed.entries.map((entry) => ({ file: '2026-10-23_160000.md', entry }));
  const exported = buildExportDocument(docs, { exportedAt: '2026-10-23T17:00:00+08:00' });
  const plan = planImport(parseMemoryFile(exported.text), { existingIds: new Set() });
  assert.equal(plan.report.accepted, 1);
  assert.equal(plan.report.failed, 0);
});

process.exitCode = report() > 0 ? 1 : 0;
