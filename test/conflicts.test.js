import assert from 'node:assert/strict';
import { createSuite } from './harness.js';
import {
  diffFields, decide, createConflict, transition, linkSupersede,
  renderConflictBlock, listConflicts, classifyField, fieldRisk, credibilityOf,
  readConflict, applyResolution,
} from '../src/conflicts.js';

const { test, report } = createSuite('conflicts');

function makeEntry(id, fields, bodyLines = []) {
  return { id, title: id, fieldMap: { ...fields }, fields: [], bodyLines, blocks: [] };
}

test('diffFields: 只比较双方都有的字段，逐字段列出', () => {
  const oldEntry = makeEntry('A', { type: 'fact', tags: 'x', event_time: '2026-10-01T00:00:00+08:00' });
  const newEntry = makeEntry('A', { type: 'fact', tags: 'y', event_time: '2026-10-01T00:00:00+08:00', extra: 'n' });
  const changes = diffFields(oldEntry, newEntry);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'tags');
  assert.equal(changes[0].oldValue, 'x');
  assert.equal(changes[0].newValue, 'y');
  assert.equal(changes[0].risk, 'low');
});

test('diffFields: 值相同不产生冲突；一方缺失算新增', () => {
  const a = makeEntry('A', { type: 'fact', tags: 'x' });
  assert.deepEqual(diffFields(a, makeEntry('A', { type: 'fact', tags: 'x' })), []);
  assert.deepEqual(diffFields(a, makeEntry('A', { type: 'fact', tags: 'x', newfield: '1' })), []);
});

test('fieldRisk / classifyField: 高风险与分级', () => {
  assert.equal(fieldRisk('tags'), 'low');
  assert.equal(fieldRisk('event_time'), 'high');
  assert.equal(fieldRisk('some_unknown'), 'medium');
  assert.equal(classifyField('event_time'), 'time');
  assert.equal(classifyField('time_source'), 'source');
  assert.equal(classifyField('status'), 'scope');
  assert.equal(classifyField('tags'), 'preference');
  assert.equal(classifyField('identity'), 'fact');
});

test('decide: 低风险 + 来源不弱 → 自动合并', () => {
  const change = { field: 'tags', oldValue: 'a', newValue: 'b', risk: 'low', level: 'preference' };
  const verdict = decide(change, { old: 'user_statement', new: 'user_statement' });
  assert.equal(verdict.action, 'auto_merge');
});

test('decide: 来源更弱 → 一律 pending，即使字段是低风险', () => {
  const change = { field: 'tags', oldValue: 'a', newValue: 'b', risk: 'low', level: 'preference' };
  const verdict = decide(change, { old: 'user_explicit', new: 'model_inferred' });
  assert.equal(verdict.action, 'pending');
  assert.match(verdict.reason, /less credible/);
});

test('decide: 高风险字段即使来源更强也要 pending', () => {
  const change = { field: 'identity', oldValue: 'a', newValue: 'b', risk: 'high', level: 'fact' };
  const verdict = decide(change, { old: 'imported', new: 'user_explicit' });
  assert.equal(verdict.action, 'pending');
  assert.equal(verdict.credibility.new > verdict.credibility.old, true);
});

test('credibilityOf: 未知来源按 0 处理', () => {
  assert.equal(credibilityOf('user_explicit'), 5);
  assert.equal(credibilityOf('nonsense'), 0);
});

test('生命周期: detected → pending → resolved，且每步留痕', () => {
  let conflict = createConflict({
    id: 'C1', level: 'fact', field: 'identity', oldValue: 'A', newValue: 'B',
    oldEntryId: 'E1', newEntryId: 'E2', at: '2026-10-23T16:00:00+08:00', reason: 'value differs',
  });
  assert.equal(conflict.state, 'detected');
  assert.equal(conflict.history.length, 1);

  conflict = transition(conflict, 'pending', { at: '2026-10-23T16:01:00+08:00', reason: '高风险字段', actor: 'plugin' });
  assert.equal(conflict.state, 'pending');
  assert.equal(conflict.history.length, 2);

  conflict = transition(conflict, 'resolved', { at: '2026-10-23T16:02:00+08:00', reason: '用户确认采用新值', actor: 'user' });
  assert.equal(conflict.state, 'resolved');
  assert.deepEqual(conflict.history.map((item) => item.state), ['detected', 'pending', 'resolved']);
});

test('生命周期: 禁止跳步与非法迁移', () => {
  const conflict = createConflict({
    id: 'C2', level: 'fact', field: 'identity', oldValue: 'A', newValue: 'B',
    oldEntryId: 'E1', newEntryId: 'E2', at: '2026-10-23T16:00:00+08:00',
  });
  assert.throws(() => transition(conflict, 'resolved', { at: 'x', reason: 'r', actor: 'u' }), /非法冲突状态迁移/);
  const pending = transition(conflict, 'pending', { at: 'x', reason: 'r', actor: 'u' });
  assert.throws(() => transition(pending, 'detected', { at: 'x', reason: 'r', actor: 'u' }), /非法冲突状态迁移/);
});

test('生命周期: 缺时间/原因/操作者时拒绝变更', () => {
  const conflict = createConflict({ id: 'C3', level: 'fact', field: 'f', oldValue: 'a', newValue: 'b', oldEntryId: 'E1', newEntryId: 'E2', at: 'now' });
  assert.throws(() => transition(conflict, 'pending', { at: 'x' }), /必须记录时间、原因与操作者/);
});

test('linkSupersede: 双向链接且败者保留为 superseded', () => {
  const loser = makeEntry('OLD', { status: 'current' });
  const winner = makeEntry('NEW', { status: 'current' });
  linkSupersede(loser, winner, { at: '2026-10-23T16:00:00+08:00' });
  assert.equal(loser.fieldMap.status, 'superseded');
  assert.equal(loser.fieldMap.superseded_by, 'NEW');
  assert.equal(loser.fieldMap.updated_at, '2026-10-23T16:00:00+08:00');
  assert.equal(winner.fieldMap.supersedes, 'OLD');
  assert.equal(loser.title, 'OLD', '败者原文不能被清掉');
});

test('renderConflictBlock: 纯文本可读，带双方值', () => {
  const conflict = createConflict({
    id: 'C4', level: 'time', field: 'covers_to', oldValue: '2026-10-01', newValue: '2026-10-02',
    oldEntryId: 'E1', newEntryId: 'E2', oldFile: 'a.md', newFile: 'b.md', at: 'now', reason: 'range differs',
  });
  const lines = renderConflictBlock(conflict).join('\n');
  assert.ok(lines.startsWith('> [!conflict]'));
  assert.ok(lines.includes('旧值: 2026-10-01'));
  assert.ok(lines.includes('新值: 2026-10-02'));
  assert.ok(lines.includes('a.md → b.md'));
});

test('listConflicts: 从条目里读回待确认冲突', () => {
  const entry = makeEntry('E', {}, []);
  entry.blocks = [
    { tag: 'conflict', text: 'fact 冲突', raw: '> [!conflict] fact 冲突' },
    { tag: 'note', text: '说明', raw: '> [!note] 说明' },
  ];
  const found = listConflicts(entry);
  assert.equal(found.length, 1);
  assert.equal(found[0].tag, 'conflict');
});

test('readConflict: 从正文读回双方值与旧条目 id', () => {
  const entry = makeEntry('E', {}, [
    '正文。',
    '',
    '> [!conflict] constraint 冲突 · 值不一致 · pending',
    '> 旧值: 记忆存在网盘',
    '> 新值: 记忆只在工作区保存',
    '> 旧条目: LT-OLD-1',
    '> 依据: 同一 kind 下值不同',
    '',
    '> [!note] 后面还有块',
  ]);
  entry.blocks = [];
  const found = readConflict(entry);
  assert.equal(found.oldId, 'LT-OLD-1');
  assert.equal(found.oldValue, '记忆存在网盘');
  assert.equal(found.newValue, '记忆只在工作区保存');
  assert.equal(found.end, 7, '冲突块止于下一个非引用行');
});

test('applyResolution accept_new: 新条目转 current，旧条目被指向', () => {
  const entry = makeEntry('E', { status: 'pending', updated_at: '2026-10-23T16:00:00+08:00' }, [
    '> [!conflict] constraint 冲突 · pending',
    '> 旧值: 旧',
    '> 新值: 新',
    '> 旧条目: LT-OLD',
  ]);
  entry.fields = [
    { key: 'status', value: 'pending' },
    { key: 'updated_at', value: '2026-10-23T16:00:00+08:00' },
  ];
  const result = applyResolution(entry, 'accept_new', { at: '2026-10-23T16:10:00+08:00', actor: 'user' });
  assert.equal(entry.fieldMap.status, 'current');
  assert.equal(entry.fieldMap.supersedes, 'LT-OLD');
  assert.equal(entry.fieldMap.updated_at, '2026-10-23T16:10:00+08:00');
  assert.ok(entry.bodyLines.some((line) => line.startsWith('> [!resolved] 采用新值')));
  assert.ok(!entry.bodyLines.some((line) => line.startsWith('> [!conflict]')));
  assert.equal(result.oldId, 'LT-OLD');
});

test('applyResolution keep_old: 新条目转 superseded 并指向旧条目', () => {
  const entry = makeEntry('E', { status: 'pending' }, [
    '> [!conflict] constraint 冲突 · pending',
    '> 旧值: 旧',
    '> 新值: 新',
    '> 旧条目: LT-OLD',
  ]);
  entry.fields = [{ key: 'status', value: 'pending' }];
  applyResolution(entry, 'keep_old', { at: '2026-10-23T16:10:00+08:00', actor: 'user' });
  assert.equal(entry.fieldMap.status, 'superseded');
  assert.equal(entry.fieldMap.superseded_by, 'LT-OLD');
  assert.ok(entry.bodyLines.some((line) => line.startsWith('> [!resolved] 保留旧值')));
});

test('applyResolution: 没有冲突块时抛错，不静默成功', () => {
  const entry = makeEntry('E', {}, ['普通正文。']);
  assert.throws(() => applyResolution(entry, 'accept_new', {}), /没有待解决的冲突/);
});

process.exitCode = report() > 0 ? 1 : 0;
