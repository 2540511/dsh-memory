import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import { parseMemoryFile } from '../src/format.js';
import { validateProposal, buildProposalEntries, buildProposalFileText } from '../src/proposals.js';

const { test, report } = createSuite('proposals');

const CORPUS = [
  '记忆只保存在用户的设备上，且只在工作区保存。',
  '我更偏好本地抽取，不要调用云端。',
].join('\n');

test('validateProposal: 逐字摘引通过', () => {
  const result = validateProposal({
    kind: 'constraint',
    value: '只在工作区保存',
    quote: '且只在工作区保存。',
  }, CORPUS);
  assert.equal(result.ok, true);
});

test('validateProposal: quote 被改写就拒绝', () => {
  const result = validateProposal({
    kind: 'constraint',
    value: '只在工作区保存',
    quote: '记忆仅在工作区里存储。',
  }, CORPUS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /逐字摘引/);
});

test('validateProposal: value 不是 quote 子串就拒绝（不能概括出额外事实）', () => {
  const result = validateProposal({
    kind: 'constraint',
    value: '只在工作区保存，绝不上传',
    quote: '且只在工作区保存。',
  }, CORPUS);
  assert.equal(result.ok, false);
  assert.match(result.reason, /子串/);
});

test('validateProposal: kind 白名单', () => {
  assert.equal(validateProposal({ kind: 'idea', value: 'x', quote: '且只在工作区保存。' }, CORPUS).ok, false);
  assert.equal(validateProposal({ kind: 'preference', value: '本地抽取', quote: '我更偏好本地抽取' }, CORPUS).ok, true);
});

test('validateProposal: 空 corpus 一律拒绝', () => {
  const result = validateProposal({ kind: 'fact', value: 'abc', quote: 'quote' }, '');
  assert.equal(result.ok, false);
});

test('buildProposalEntries: 提案是 pending，不直接生效', () => {
  const entries = buildProposalEntries([
    { kind: 'constraint', value: '只在工作区保存', quote: '且只在工作区保存。' },
  ], { savedAt: '2026-10-23T17:00:00+08:00', timezone: 'Asia/Shanghai', stamp: '2026-10-23_170000' });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].fieldMap.status, 'pending');
  assert.equal(entries[0].fieldMap.proposal_source, 'model');
  assert.equal(entries[0].fieldMap.decay, 'none');
  assert.ok(entries[0].id.startsWith('PR-2026-10-23-170000'));
  assert.ok(entries[0].bodyLines.some((line) => line.startsWith('> [!proposed]')));
});

test('buildProposalFileText: 能被格式层解析，且条目仍是 pending', () => {
  const entries = buildProposalEntries([
    { kind: 'constraint', value: '只在工作区保存', quote: '且只在工作区保存。' },
    { kind: 'preference', value: '本地抽取', quote: '我更偏好本地抽取' },
  ], { savedAt: '2026-10-23T17:00:00+08:00', timezone: 'Asia/Shanghai', stamp: '2026-10-23_170000' });

  const text = buildProposalFileText(entries, { at: '2026-10-23T17:00:00+08:00' });
  const doc = parseMemoryFile(text);
  assert.equal(doc.issues.length, 0, JSON.stringify(doc.issues));
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.frontMatter.data.memory_class, 'proposal');
  assert.ok(doc.entries.every((entry) => entry.fieldMap.status === 'pending'));
});

process.exitCode = report() > 0 ? 1 : 0;
