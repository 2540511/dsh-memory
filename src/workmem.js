/**
 * 工作记忆：逐字转录 + 单独生成的 diff + 分卷。
 *
 * 与聊天记忆的区别是硬边界，不是参数：
 * - 不摘要：正文就是原文，`verbatim: true`；
 * - 不衰减、不回收：`purge_after: never`、`details_purged: false`；
 * - 冲突一律人工确认：`conflict_policy: manual`；
 * - 体积按 256KB / 2000 行分卷，每卷独立 front matter。
 */
import { renderEntry, estimateTokens } from './format.js';

export const WORK_MAX_BYTES = 256 * 1024;
export const WORK_MAX_LINES = 2000;

/** 按"用户发言"切轮次；助手与工具输出归入当前轮 */
export function buildTurns(messages) {
  const turns = [];
  let current = null;
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === 'user' || current === null) {
      current = { index: turns.length + 1, messages: [] };
      turns.push(current);
    }
    current.messages.push(message);
  }
  return turns;
}

function oneLine(text, limit) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function pad(value, width = 3) {
  return String(value).padStart(width, '0');
}

/**
 * 生成逐字条目，一轮一条。
 * @returns {Array} 可直接交给 format.renderEntry 的条目对象
 */
export function buildWorkEntries(input) {
  const { messages, savedAt, timezone, stamp, seqStart = 1, idPrefix = 'WK' } = input;
  const turns = buildTurns(messages);

  return turns.map((turn, index) => {
    const seq = seqStart + index;
    const first = turn.messages[0];
    const last = turn.messages[turn.messages.length - 1];
    const bodyLines = [];

    for (const message of turn.messages) {
      const who = message.role === 'user' ? '用户' : message.role === 'tool' ? '工具' : '助手';
      bodyLines.push(`**${who}**（${message.time || savedAt}）`);
      bodyLines.push('');
      bodyLines.push(...String(message.text || '').split('\n'));
      bodyLines.push('');
    }

    const fields = [
      ['type', 'work_record'],
      ['memory_class', 'work'],
      ['verbatim', 'true'],
      ['turn', String(turn.index)],
      ['source_seqs', `${first.seq ?? 'unknown'}-${last.seq ?? 'unknown'}`],
      ['event_time', first.time || savedAt],
      ['recorded_at', savedAt],
      ['updated_at', savedAt],
      ['timezone', timezone],
      ['time_source', 'system_clock'],
      ['confidence', '1.0'],
      ['privacy', 'device_local'],
      ['status', 'current'],
      ['tags', 'work, verbatim'],
      ['seq', String(seq)],
      ['details_purged', 'false'],
      ['purge_after', 'never'],
      ['conflict_policy', 'manual'],
      ['weight_exempt', 'true'],
    ].map(([key, value]) => ({ key, value }));

    return {
      id: `${idPrefix}-${String(stamp).replace('_', '-')}-${pad(seq)}`,
      title: `第 ${turn.index} 轮 · ${oneLine(first.text, 30)}`,
      fields,
      bodyLines,
      fieldMap: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    };
  });
}

/** 把 diff 变成条目：一个文件一条，正文是 hunk 原文 */
export function buildDiffEntries(input) {
  const { diffs, savedAt, timezone, stamp, seqStart } = input;
  return (diffs || []).map((diff, index) => {
    const seq = seqStart + index;
    const bodyLines = [];
    if (diff.kind === 'text') {
      for (const hunk of diff.hunks || []) {
        bodyLines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
        bodyLines.push(...hunk.lines);
      }
    } else {
      bodyLines.push(`> 该文件无法比较（${diff.kind}），只记录路径与统计。`);
    }

    const fields = [
      ['type', 'work_diff'],
      ['memory_class', 'work'],
      ['verbatim', 'true'],
      ['evidence_kind', 'diff'],
      ['file_path', diff.path],
      ['added', String(diff.added ?? 0)],
      ['deleted', String(diff.deleted ?? 0)],
      ['diff_kind', diff.kind],
      ['event_time', diff.eventTime || savedAt],
      ['recorded_at', savedAt],
      ['updated_at', savedAt],
      ['timezone', timezone],
      ['time_source', 'system_clock'],
      ['confidence', '1.0'],
      ['privacy', 'device_local'],
      ['status', 'current'],
      ['tags', 'work, diff'],
      ['seq', String(seq)],
      ['details_purged', 'false'],
      ['purge_after', 'never'],
      ['conflict_policy', 'manual'],
      ['weight_exempt', 'true'],
    ].map(([key, value]) => ({ key, value }));

    return {
      id: `WD-${String(stamp).replace('_', '-')}-${pad(seq)}`,
      title: `变更 · ${oneLine(diff.display || diff.path, 40)}`,
      fields,
      bodyLines,
      fieldMap: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    };
  });
}

/** 估算一个条目渲染后的体积 */
export function measureEntry(entry) {
  const text = renderEntry({ ...entry, trailing: '\n' });
  return { text, bytes: Buffer.byteLength(text, 'utf8'), lines: text.split('\n').length };
}

/**
 * 分卷：单卷超过 256KB 或 2000 行就切下一卷。
 * 返回 [{entries:[{entry,text}], bytes, lines}]，顺序即卷序。
 */
export function packVolumes(entries, options = {}) {
  const maxBytes = options.maxBytes ?? WORK_MAX_BYTES;
  const maxLines = options.maxLines ?? WORK_MAX_LINES;
  const volumes = [];
  let current = [];
  let bytes = 0;
  let lines = 0;

  for (const entry of entries || []) {
    const measured = measureEntry(entry);
    if (current.length > 0 && (bytes + measured.bytes > maxBytes || lines + measured.lines > maxLines)) {
      volumes.push({ entries: current, bytes, lines });
      current = [];
      bytes = 0;
      lines = 0;
    }
    current.push({ ...measured, entry });
    bytes += measured.bytes;
    lines += measured.lines;
  }
  if (current.length > 0) volumes.push({ entries: current, bytes, lines });
  return volumes;
}

/** 索引区块：工作记忆条目多，只列前 40 条并注明总数 */
export function buildWorkIndexBlock(entries, options = {}) {
  const limit = options.limit ?? 40;
  const lines = [
    '## 记忆索引',
    '',
    '> 索引仅用于快速定位，权威内容以条目正文为准。工作记忆逐字保存，不做摘要。',
    '',
  ];
  for (const entry of entries.slice(0, limit)) {
    lines.push(`- ${entry.id}: ${entry.title} · event_time=${entry.fieldMap.event_time} · status=${entry.fieldMap.status}`);
  }
  if (entries.length > limit) {
    lines.push(`- …另有 ${entries.length - limit} 条，未列入索引，请按 seq 顺序查看正文。`);
  }
  return lines.join('\n');
}

/**
 * 组装一卷工作记忆文件。
 * @returns {{text: string, indexTokensEst: number}}
 */
export function buildWorkFileText(input) {
  const { session, entries, savedAt, stamp, timezone, part = 1, totalParts = 1 } = input;
  const indexBlock = buildWorkIndexBlock(entries);
  const indexTokensEst = estimateTokens(indexBlock);

  const front = [
    '---',
    'memory_format: dsh-memory',
    'format_version: 1',
    `saved_at: ${savedAt}`,
    `session_name: ${oneLine(session.title || session.sessionId, 80)}`,
    `session_id: ${session.sessionId}`,
    `message_range: ${session.messageRange}`,
    'memory_class: work',
    'summary_model: none',
    'summary_authoritative: false',
    'summary_status: navigation_only',
    `volume_kind: ${input.volumeKind || 'work'}`,
    `part: ${part}`,
    `total_parts: ${totalParts}`,
    `entries: ${entries.length}`,
    `index_tokens_est: ${indexTokensEst}`,
    '---',
    '',
  ].join('\n');

  const body = entries.map((entry) => renderEntry({ ...entry, trailing: '\n' })).join('');
  return { text: `${front}${indexBlock}\n\n${body}`, indexTokensEst };
}
