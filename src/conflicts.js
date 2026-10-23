/**
 * 冲突引擎：字段级检测、分级、可信度裁决、生命周期、双向链接。
 *
 * 纯函数，不碰 IO。核心约束来自规格：
 * - 冲突精确到字段，不做整条覆盖；
 * - 低可信来源不得覆盖高可信来源，只能 pending；
 * - 只有低风险字段允许自动合并，高风险字段一律 pending；
 * - 状态变更必须留痕（时间、原因、操作者、依据），不允许静默跳步；
 * - 败者保留原文与时间戳，用 supersedes / superseded_by 建立双向链接。
 */

/** 字段风险：低风险才可能自动合并 */
export const LOW_RISK_FIELDS = new Set(['tags', 'display_format', 'weight', 'weight_bucket', 'summary', 'summary_status']);

/** 高风险字段（身份、偏好、约束、事实、时间） */
export const HIGH_RISK_FIELDS = new Set([
  'type', 'event_time', 'recorded_at', 'status', 'confidence', 'privacy',
  'memory_class', 'identity', 'preference', 'constraint', 'fact', 'covers_to', 'covers_from',
]);

/** 来源可信度：用户明确指定 > 用户直接陈述 > 系统观测 > 导入数据 > 模型推断 */
export const CREDIBILITY = {
  user_explicit: 5,
  user_statement: 4,
  system_observed: 3,
  imported: 2,
  model_inferred: 1,
  unknown: 0,
};

export function credibilityOf(source) {
  return CREDIBILITY[source] !== undefined ? CREDIBILITY[source] : 0;
}

export function fieldRisk(field) {
  if (LOW_RISK_FIELDS.has(field)) return 'low';
  if (HIGH_RISK_FIELDS.has(field)) return 'high';
  return 'medium';
}

/** 冲突分级：事实 / 偏好 / 时间 / 范围 / 来源 */
export function classifyField(field) {
  if (field === 'event_time' || field === 'recorded_at' || field === 'updated_at' || field === 'covers_to' || field === 'covers_from') return 'time';
  if (field === 'type' || field === 'memory_class' || field === 'status') return 'scope';
  if (field === 'time_source' || field === 'privacy' || field === 'confidence') return 'source';
  if (field === 'tags' || field === 'weight' || field === 'weight_bucket' || field === 'summary') return 'preference';
  return 'fact';
}

/**
 * 字段级比较。只比较双方都有的字段——一方缺失是"新增"，不是冲突。
 * @returns {Array<{field, oldValue, newValue, risk, level}>}
 */
export function diffFields(oldEntry, newEntry) {
  const oldMap = (oldEntry && oldEntry.fieldMap) || {};
  const newMap = (newEntry && newEntry.fieldMap) || {};
  const changes = [];
  for (const field of Object.keys(newMap)) {
    if (!(field in oldMap)) continue;
    if (oldMap[field] === newMap[field]) continue;
    changes.push({
      field,
      oldValue: oldMap[field],
      newValue: newMap[field],
      risk: fieldRisk(field),
      level: classifyField(field),
    });
  }
  return changes;
}

/**
 * 裁决一个字段变化该怎么处理。
 * @param {object} change  diffFields 的一项
 * @param {object} sources {old: 来源标识, new: 来源标识}
 * @returns {{action: 'auto_merge'|'pending', reason: string, credibility: {old:number,new:number}}}
 */
export function decide(change, sources = {}) {
  const oldScore = credibilityOf(sources.old);
  const newScore = credibilityOf(sources.new);
  const credibility = { old: oldScore, new: newScore };

  if (change.risk === 'low' && newScore >= oldScore) {
    return { action: 'auto_merge', reason: 'low-risk field, source not weaker', credibility };
  }
  if (newScore < oldScore) {
    return { action: 'pending', reason: 'incoming source is less credible; cannot overwrite', credibility };
  }
  return { action: 'pending', reason: `${change.risk}-risk field requires confirmation`, credibility };
}

export const LIFECYCLE = ['detected', 'pending', 'resolved', 'merged', 'superseded', 'deprecated'];

const ALLOWED = {
  detected: ['pending', 'merged', 'deprecated'],
  pending: ['resolved', 'merged', 'superseded', 'deprecated'],
  resolved: [],
  merged: [],
  superseded: [],
  deprecated: [],
};

/** 建一条冲突记录（状态 detected） */
export function createConflict(input) {
  return {
    id: input.id,
    state: 'detected',
    level: input.level,
    field: input.field,
    oldValue: input.oldValue,
    newValue: input.newValue,
    oldEntryId: input.oldEntryId,
    newEntryId: input.newEntryId,
    oldFile: input.oldFile,
    newFile: input.newFile,
    reason: input.reason || '',
    history: [{
      at: input.at,
      state: 'detected',
      reason: input.reason || 'field value differs',
      actor: input.actor || 'plugin',
      basis: input.basis || 'field comparison',
    }],
  };
}

/** 状态迁移；非法迁移直接抛错，不允许静默跳步 */
export function transition(conflict, next, meta = {}) {
  const allowed = ALLOWED[conflict.state] || [];
  if (!allowed.includes(next)) {
    throw new Error(`非法冲突状态迁移: ${conflict.state} -> ${next}`);
  }
  if (!meta.at || !meta.reason || !meta.actor) {
    throw new Error('冲突状态变更必须记录时间、原因与操作者');
  }
  return {
    ...conflict,
    state: next,
    history: [...conflict.history, {
      at: meta.at,
      state: next,
      reason: meta.reason,
      actor: meta.actor,
      basis: meta.basis || '',
    }],
  };
}

/** 把冲突写成 Markdown 引用块，纯文本环境下退化为普通引用 */
export function renderConflictBlock(conflict) {
  const lines = [
    `> [!conflict] ${conflict.level} 冲突 · ${conflict.field} · ${conflict.state}`,
    `> 旧值: ${conflict.oldValue}`,
    `> 新值: ${conflict.newValue}`,
    `> 旧条目: ${conflict.oldEntryId || 'unknown'}`,
    `> 来源: ${conflict.oldFile || conflict.oldEntryId} → ${conflict.newFile || conflict.newEntryId}`,
    `> 依据: ${conflict.reason}`,
  ];
  return lines;
}

/**
 * 从一个条目的正文里读回冲突信息（用于解决）。
 * @returns {{oldId, oldValue, newValue, lineIndex, lines}|null}
 */
export function readConflict(entry) {
  const lines = entry.bodyLines || [];
  const start = lines.findIndex((line) => /^>[ \t]*\[!conflict\]/.test(line));
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!/^>/.test(lines[i])) { end = i; break; }
  }

  const block = lines.slice(start, end);
  const grab = (label) => {
    const found = block.find((line) => line.includes(`${label}:`));
    return found ? found.slice(found.indexOf(`${label}:`) + label.length + 1).trim() : '';
  };

  return {
    start,
    end,
    oldId: grab('旧条目'),
    oldValue: grab('旧值'),
    newValue: grab('新值'),
    reason: grab('依据'),
  };
}

/**
 * 裁决一条 pending 冲突，返回改好的条目（原地修改并返回说明）。
 *
 * accept_new：新条目转 current，旧条目转 superseded 并指向新条目；
 * keep_old：新条目转 superseded 并指向旧条目，旧条目保持 current。
 * 两种情况都把 [!conflict] 块换成 [!resolved]，保留双方值以便追溯。
 */
export function applyResolution(entry, action, meta = {}) {
  const found = readConflict(entry);
  if (!found) throw new Error('这个条目没有待解决的冲突');
  const at = meta.at || new Date().toISOString();
  const actor = meta.actor || 'user';

  const verdict = action === 'accept_new' ? 'adopt new value' : 'keep old value';
  const note = [
    `> [!resolved] ${action === 'accept_new' ? '采用新值' : '保留旧值'} · ${at} · ${actor}`,
    `> 旧值: ${found.oldValue}`,
    `> 新值: ${found.newValue}`,
    `> 旧条目: ${found.oldId || 'unknown'}`,
    `> 依据: ${verdict}`,
  ];

  entry.bodyLines = [...entry.bodyLines.slice(0, found.start), ...note, ...entry.bodyLines.slice(found.end)];

  const setField = (key, value) => {
    const field = (entry.fields || []).find((item) => item.key === key);
    if (field) field.value = value;
    entry.fieldMap[key] = value;
  };

  if (action === 'accept_new') {
    setField('status', 'current');
    if (found.oldId) setField('supersedes', found.oldId);
  } else {
    setField('status', 'superseded');
    if (found.oldId) setField('superseded_by', found.oldId);
  }
  setField('updated_at', at);

  return { entry, wrote: action, oldId: found.oldId, oldValue: found.oldValue, newValue: found.newValue };
}

/**
 * 建立双向 supersede 链接。
 * 返回 {loser, winner}：loser 标 superseded 并写回指针，winner 记 supersedes。
 */
export function linkSupersede(loserEntry, winnerEntry, meta = {}) {
  const loserMap = loserEntry.fieldMap || {};
  const winnerMap = winnerEntry.fieldMap || {};
  loserMap.status = 'superseded';
  loserMap.superseded_by = winnerEntry.id;
  if (meta.at) loserMap.updated_at = meta.at;
  winnerMap.supersedes = loserEntry.id;
  return { loserEntry, winnerEntry };
}

/** 从条目里读出待确认冲突（正文里的 [!conflict] 块） */
export function listConflicts(entry) {
  return (entry.blocks || [])
    .filter((block) => block.tag === 'conflict')
    .map((block) => ({ tag: block.tag, text: block.text, raw: block.raw }));
}
