/**
 * 多媒体记忆：只存文本描述，不存原文件。
 *
 * 与 B 方案的唯一例外：图片/文件描述由"已经在会话里看到它的模型"提供，
 * 插件不额外发请求、不读二进制、不建附件目录。描述拿不到就保持 pending。
 */
import { renderEntry } from './format.js';

/**
 * 从会话事件里找出多媒体块（图片、文件）。
 * 同一附件只记一次。
 */
export function extractMediaFromEvents(events) {
  const items = [];

  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    const content = event.type === 'user/message'
      ? event.data && event.data.content
      : event.type === 'tool/result'
        ? event.data && event.data.message && event.data.message.content
        : null;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'image' && block.type !== 'file') continue;
      const attachment = block.attachment;
      if (!attachment) continue;
      items.push({
        mediaType: block.type === 'image' ? 'image' : 'file',
        mediaSource: attachment.attachmentId || 'unknown',
        name: attachment.name || '',
        mime: attachment.mediaType || '',
        bytes: Number(attachment.bytes) || 0,
        width: Number(attachment.width) || 0,
        height: Number(attachment.height) || 0,
        time: event.time,
        seq: event.seq,
      });
    }
  }

  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.mediaType}:${item.mediaSource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const TYPE_LABEL = { image: '图片', file: '文件', audio: '音频', video: '视频' };

/**
 * 构造 media_summary 条目。默认待补描述。
 */
export function buildMediaEntries(items, input = {}) {
  const { savedAt, timezone, stamp, seqStart, toIso } = input;
  return (items || []).map((item, index) => {
    const seq = seqStart + index;
    const label = TYPE_LABEL[item.mediaType] || item.mediaType;
    // 事件里是毫秒时间戳，条目必须写 ISO 8601；转换不了就退回保存时间
    const eventTime = typeof item.time === 'number'
      ? (typeof toIso === 'function' ? toIso(item.time) : savedAt)
      : (item.time || savedAt);
    const detail = [
      item.name ? `名称 ${item.name}` : '',
      item.mime ? `类型 ${item.mime}` : '',
      item.bytes ? `${item.bytes} 字节` : '',
      item.width && item.height ? `${item.width}×${item.height}` : '',
    ].filter(Boolean).join(' · ');

    const fields = [
      ['type', 'media_summary'],
      ['media_type', item.mediaType],
      ['media_retained', 'false'],
      ['media_source', item.mediaSource],
      ['media_original_url', 'unknown'],
      ['media_desc_model', 'none'],
      ['media_desc_status', 'pending'],
      ['event_time', eventTime],
      ['recorded_at', savedAt],
      ['updated_at', savedAt],
      ['timezone', timezone],
      ['time_source', 'system_clock'],
      ['confidence', '0.5'],
      ['privacy', 'device_local'],
      ['status', 'pending'],
      ['tags', 'media, pending'],
      ['seq', String(seq)],
      ['decay', 'none'],
      ['purge_after', 'never'],
      ['details_purged', 'false'],
    ].map(([key, value]) => ({ key, value }));

    return {
      id: `MD-${String(stamp).replace('_', '-')}-${String(seq).padStart(3, '0')}`,
      title: `多媒体 · ${label}${item.name ? ` · ${item.name}` : ''}`,
      fields,
      bodyLines: [
        `描述待补：这是一条 ${label} 记录，原始媒体**未保存**（media_retained=false），无法据此还原文件。`,
        '',
        `> [!media] 原始媒体未保存（${label}${detail ? `；${detail}` : ''}）。`,
        '> 描述由看到该媒体的模型补充后，本条目才会转为 current。',
      ],
      fieldMap: Object.fromEntries(fields.map((field) => [field.key, field.value])),
    };
  });
}

/** 把描述写进条目：转 current，记录模型与实际状态 */
export function applyDescription(entry, description, meta = {}) {
  const text = String(description || '').trim();
  if (!text) throw new Error('描述为空');

  const setField = (key, value) => {
    const field = (entry.fields || []).find((item) => item.key === key);
    if (field) field.value = value;
    entry.fieldMap[key] = value;
  };

  setField('media_desc_model', meta.model || 'deepseek-flash');
  setField('media_desc_status', 'current');
  setField('status', 'current');
  setField('updated_at', meta.at || new Date().toISOString());
  setField('confidence', '0.8');
  setField('tags', 'media');

  entry.bodyLines = [
    text,
    '',
    `> [!media] 原始媒体未保存（${TYPE_LABEL[entry.fieldMap.media_type] || entry.fieldMap.media_type}），本条只是文本描述，不能还原文件。`,
  ];
  return entry;
}

/** 组装含多媒体条目的文件片段（与摘要条目同一份文件） */
export function renderMediaEntry(entry) {
  return renderEntry({ ...entry, trailing: '\n' });
}
