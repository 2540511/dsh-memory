/**
 * 长期要点抽取：把偏好 / 约束 / 目标 / 决定抽成独立条目。
 *
 * 与摘要的关系：摘要是"这次会话讲了什么"，长期要点是"以后一直要遵守什么"。
 * 抽取仍然是纯本地的规则匹配，quote 一律是原文子串，不生成新句子。
 *
 * 冲突匹配是**粗粒度**的：同一个 kind 下值不同即视为冲突（宁可 pending，不可覆盖）。
 * 语义级"这两句话其实在说同一件事"需要模型判断，这里不做，也不假装做了。
 */

export const LONG_TERM_KINDS = ['preference', 'constraint', 'goal', 'fact'];

/** kind → 触发规则；quote 必须原样保留 */
const RULES = [
  {
    kind: 'constraint',
    re: /(?:记住|务必|必须|一定要|不要|不准|禁止|只能|不得|统一成|统一用|只在|仅存|仅|永久|一律|永远)(.{2,})/,
  },
  {
    kind: 'preference',
    re: /(?:我更?偏好|我更?喜欢|我习惯|我倾向|我希望|我要|以后都|从现在起)(.{2,})/,
  },
  {
    kind: 'goal',
    re: /(?:目标是|计划|打算|接下来要|下一步要|明天要)(.{2,})/,
  },
  {
    kind: 'fact',
    re: /(?:决定|确定|定为|采用)(.{2,})/,
  },
];

/** 同一 kind 的条目之间才比较冲突 */
export function subjectOf(kind) {
  return kind;
}

/**
 * 从消息里抽长期要点。
 *
 * 有上限：只取最近 max 条（新的表述优先），否则用户发一段需求清单就会
 * 抽出几十条"约束"，把启动包撑爆。宁可少记，不可淹没。
 *
 * @returns {Array<{kind, subject, value, quote, time, seq}>}
 */
export function extractLongTerm(messages, options = {}) {
  const max = options.max ?? 5;
  const found = [];
  const seen = new Set();

  const ordered = [...(messages || [])].reverse(); // 从最近往前
  for (const message of ordered) {
    if (!message || message.role !== 'user') continue; // 只认用户自己的表述
    const text = String(message.text || '');
    if (!text) continue;

    for (const sentence of text.split(/(?<=[。！？；!?;\n])/)) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      // 一句可能命中多条规则（"我更偏好 A，不要 B"），取线索位置最靠前的那条
      let best = null;
      for (const rule of RULES) {
        const match = rule.re.exec(trimmed);
        if (!match) continue;
        if (!best || match.index < best.index) best = { rule, match, index: match.index };
      }
      if (!best) continue;

      // 取值取整句，而不是线索之后的残段——"不得静默丢弃"这种尾巴读不出含义
      const value = trimmed.replace(/[。！？；\s]+$/, '').trim();
      if (value.length < 4) continue;
      if (value.length > 80) continue; // 长段多半是清单或整段需求，不是一条要点
      if (/^\d+[.、)]/.test(value)) continue; // 编号清单项不是要点
      if (/\s{2,}/.test(value)) continue; // 多空格是排版痕迹，多半来自列表
      const key = `${best.rule.kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        kind: best.rule.kind,
        subject: subjectOf(best.rule.kind),
        value,
        quote: trimmed,
        time: message.time || null,
        seq: message.seq ?? null,
      });
      if (found.length >= max) return found;
    }
  }
  return found;
}

/**
 * 构造长期要点条目。
 * 长期要点不衰减（weight 100，decay none），也不参与 20 天回收。
 */
export function buildLongTermEntries(items, input = {}) {
  const { savedAt, timezone, stamp, seqStart = 2 } = input;
  return (items || []).map((item, index) => {
    const seq = seqStart + index;
    const fields = [
      ['type', 'long_term'],
      ['kind', item.kind],
      ['subject', item.subject],
      ['value', item.value],
      ['event_time', item.time || savedAt],
      ['recorded_at', savedAt],
      ['updated_at', savedAt],
      ['timezone', timezone],
      ['time_source', 'system_clock'],
      ['confidence', '0.8'],
      ['privacy', 'device_local'],
      ['status', 'current'],
      ['tags', 'long_term'],
      ['seq', String(seq)],
      ['weight', '100'],
      ['weight_bucket', 'hot'],
      ['weight_decay', 'none'],
      ['decay', 'none'],
      ['purge_after', 'never'],
      ['details_purged', 'false'],
      ['conflict_policy', 'manual'],
    ].map(([key, value]) => ({ key, value }));

    return {
      id: `LT-${String(stamp).replace('_', '-')}-${String(seq).padStart(3, '0')}`,
      title: `长期要点 · ${LABELS[item.kind] || item.kind} · ${item.value.slice(0, 30)}`,
      fields,
      bodyLines: [
        item.quote,
        '',
        '> [!note] 原文摘录，未经改写；权威内容以本条正文为准。',
      ],
      fieldMap: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    };
  });
}

const LABELS = {
  preference: '偏好',
  constraint: '约束',
  goal: '目标',
  fact: '事实',
};

/**
 * 保守的冲突检测：同 kind、值不同、旧条目仍 current，**且两个值有足够长的公共前缀**。
 *
 * 为什么加前缀条件：只按 kind 比较的话，"约束"这一类的任意两句话都会互相冲突，
 * 实测一次保存就能刷出 62 条假冲突。这里宁可漏报，也不制造噪音。
 */
function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index += 1;
  return index;
}

export function findConflicts(entries, existing, options = {}) {
  const minPrefix = options.minPrefix ?? 4;
  const byKind = new Map();
  for (const doc of existing || []) {
    const map = doc.entry.fieldMap || {};
    if (map.type !== 'long_term') continue;
    if (map.status !== 'current') continue;
    if (!byKind.has(map.kind)) byKind.set(map.kind, []);
    byKind.get(map.kind).push({ id: doc.entry.id, value: map.value || '', file: doc.file });
  }

  const conflicts = [];
  for (const entry of entries || []) {
    const kind = entry.fieldMap.kind;
    const peers = byKind.get(kind) || [];
    const value = entry.fieldMap.value || '';
    const other = peers.find((peer) => peer.value !== value && commonPrefixLength(peer.value, value) >= minPrefix);
    if (other) conflicts.push({ entry, against: other });
  }
  return conflicts;
}

/** 把冲突写进条目：状态 pending + [!conflict] 块 */
export function markPending(entry, against, meta = {}) {
  const statusField = entry.fields.find((field) => field.key === 'status');
  if (statusField) statusField.value = 'pending';
  entry.fieldMap.status = 'pending';

  entry.bodyLines.push(
    '',
    `> [!conflict] ${entry.fieldMap.kind} 冲突 · 值不一致 · pending`,
    `> 旧值: ${against.value}（${against.file || against.id}）`,
    `> 新值: ${entry.fieldMap.value}`,
    `> 旧条目: ${against.id}`,
    `> 依据: 同一 kind 下值不同，需人工确认；旧条目保持 current，未被覆盖。`,
  );
  if (meta.at) {
    const updated = entry.fields.find((field) => field.key === 'updated_at');
    if (updated) updated.value = meta.at;
    entry.fieldMap.updated_at = meta.at;
  }
  return entry;
}
