/**
 * 把会话事件归一成抽取器能吃的消息数组。
 *
 * 只读"当前表面"上的 append 事件：被 replace 掉的历史（surfaceOp.op === 'replace'）
 * 不参与摘要，否则同一句话会在摘要里出现两次。
 */

const SURFACE_APPEND = (event) => {
  if (event.surface !== undefined) return event.surface === 'current';
  return event.surfaceOp === undefined || event.surfaceOp === 'append';
};

/** 宿主注入到用户消息里的运行时上下文行，不属于用户说的话 */
const INJECTED_LINE = /^(Current runtime context\.|Current DSH |Current DeepSeek Harness |Current working directory:|Approval policy:|Browser time zone|Elapsed since the preceding model-visible message:|Time sampled while preparing turn|记忆索引（低 token 启动包|## 记忆索引$|> 索引仅用于快速定位|> 处于 pending|> 权威内容以|-?\s?index_tokens_est:|- (LT|SG|WK|WD)-\d{4}-)/;

/**
 * 去掉宿主注入的运行时上下文与 system-reminder。
 * 不做这一步，抽取器会把 "Current runtime context..." 当成用户的事实来摘要。
 */
export function sanitizeUserText(text) {
  let out = String(text || '');
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  out = out.replace(/<system-reminder>[\s\S]*$/g, '');
  const kept = out
    .split('\n')
    .filter((line) => !INJECTED_LINE.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return kept;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * @param {Array} events readSession() 返回的原始事件
 * @param {(ms:number)=>string} toIso 毫秒时间戳转带时区 ISO
 */
export function extractMessages(events, toIso) {
  const messages = [];
  const iso = typeof toIso === 'function' ? toIso : (ms) => new Date(ms).toISOString();

  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    if (!SURFACE_APPEND(event)) continue;

    if (event.type === 'user/message') {
      const text = sanitizeUserText(textOf(event.data && event.data.content));
      if (text) messages.push({ role: 'user', text, time: iso(event.time), seq: event.seq });
      continue;
    }

    if (event.type === 'assistant/message') {
      const message = event.data && event.data.message;
      const text = textOf(message && message.content);
      if (text) messages.push({ role: 'assistant', text, time: iso(event.time), seq: event.seq });
      continue;
    }

    if (event.type === 'tool/result') {
      const message = event.data && event.data.message;
      const text = textOf(message && message.content);
      if (text && event.data && event.data.error) {
        messages.push({ role: 'tool', text: `工具失败：${text}`, time: iso(event.time), seq: event.seq });
      }
    }
  }
  return messages;
}

/** 会话时间范围、消息数、最后活动时间 */
export function summarizeEvents(events) {
  let messageCount = 0;
  let first = null;
  let last = null;

  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    if (typeof event.time === 'number') {
      if (first === null || event.time < first) first = event.time;
      if (last === null || event.time > last) last = event.time;
    }
    if (!SURFACE_APPEND(event)) continue;
    if (event.type === 'user/message' || event.type === 'assistant/message') messageCount += 1;
  }

  return { messageCount, startTime: first, endTime: last };
}
