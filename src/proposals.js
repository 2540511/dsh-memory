/**
 * 模型提议的长期要点：只接受逐字摘引。
 *
 * 为什么这么严：模型概括很容易写出原文没有的事实。这里要求
 * quote 必须能在**本会话用户原话**里逐字找到，value 又必须是 quote 的子串，
 * 于是"记忆内容 ⊆ 用户说过的话"是构造性成立的，不靠模型自觉。
 */
import { renderEntry } from './format.js';

export const PROPOSAL_KINDS = ['preference', 'constraint', 'goal', 'fact'];
export const MAX_PROPOSALS = 5;

const LABEL = { preference: '偏好', constraint: '约束', goal: '目标', fact: '事实' };

/**
 * 校验一条提议。
 * @param {object} item {kind, value, quote}
 * @param {string} corpus 本会话用户原话（已去注入内容）
 * @returns {{ok:true, kind, value, quote} | {ok:false, reason:string}}
 */
export function validateProposal(item, corpus) {
  if (!item || typeof item !== 'object') return { ok: false, reason: '提议不是对象' };
  const kind = String(item.kind || '').trim();
  const value = String(item.value || '').trim();
  const quote = String(item.quote || '').trim();

  if (!PROPOSAL_KINDS.includes(kind)) {
    return { ok: false, reason: `kind 必须是 ${PROPOSAL_KINDS.join(' / ')}` };
  }
  if (quote.length < 4) return { ok: false, reason: 'quote 太短，至少 4 个字' };
  if (!String(corpus || '').includes(quote)) {
    return { ok: false, reason: 'quote 不是本会话用户原话（必须逐字摘引，不能改写）' };
  }
  if (value.length < 2) return { ok: false, reason: 'value 太短' };
  if (!quote.includes(value)) {
    return { ok: false, reason: 'value 必须是 quote 的子串（同样不能改写）' };
  }
  return { ok: true, kind, value, quote };
}

/**
 * 构造 pending 条目。提议不直接生效，必须由用户确认。
 */
export function buildProposalEntries(validItems, input = {}) {
  const { savedAt, timezone, stamp, seqStart = 1 } = input;
  return (validItems || []).map((item, index) => {
    const seq = seqStart + index;
    const fields = [
      ['type', 'long_term'],
      ['kind', item.kind],
      ['value', item.value],
      ['event_time', item.time || savedAt],
      ['recorded_at', savedAt],
      ['updated_at', savedAt],
      ['timezone', timezone],
      ['time_source', 'system_clock'],
      ['confidence', '0.6'],
      ['privacy', 'device_local'],
      ['status', 'pending'],
      ['tags', 'long_term, proposed'],
      ['seq', String(seq)],
      ['weight', '100'],
      ['weight_bucket', 'hot'],
      ['decay', 'none'],
      ['purge_after', 'never'],
      ['details_purged', 'false'],
      ['conflict_policy', 'manual'],
      ['proposal_source', 'model'],
    ].map(([key, value]) => ({ key, value }));

    return {
      id: `PR-${String(stamp).replace('_', '-')}-${String(seq).padStart(3, '0')}`,
      title: `待确认 · ${LABEL[item.kind] || item.kind} · ${item.value.slice(0, 24)}`,
      fields,
      bodyLines: [
        item.quote,
        '',
        `> [!proposed] 模型提议，尚未生效；确认后才成为长期要点。`,
        `> 摘引自本会话用户原话，未改写。`,
      ],
      fieldMap: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    };
  });
}

/** 组装提议文件 */
export function buildProposalFileText(entries, input = {}) {
  const head = [
    '---',
    'memory_format: dsh-memory',
    'format_version: 1',
    `saved_at: ${input.at}`,
    'memory_class: proposal',
    'summary_model: none',
    `entries: ${entries.length}`,
    'index_tokens_est: 0',
    '---',
    '',
  ].join('\n');
  return `${head}${entries.map((entry) => renderEntry({ ...entry, trailing: '\n' })).join('')}`;
}
