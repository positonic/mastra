import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability';

// Generation/step/run spans embed the full message history (Zoe's prompt is
// ~65K chars, up to 12 steps per turn) — persisting that verbatim into the
// shared memory Postgres is a slow-motion disk-fill. Cap those payloads but
// leave tool-call spans untouched: tool inputs are the incident-diagnosis
// signal this tracing exists to capture (2026-06-12 web_fetch incident).
const SPAN_PAYLOAD_CHAR_CAP = 2_000;
const BULKY_SPAN_TYPES = new Set(['agent_run', 'model_generation', 'model_step', 'model_chunk']);

function truncatePayload(value: unknown): unknown {
  if (value == null) return value;
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
  if (serialized == null || serialized.length <= SPAN_PAYLOAD_CHAR_CAP) return value;
  return `${serialized.slice(0, SPAN_PAYLOAD_CHAR_CAP)}…[truncated ${serialized.length} chars]`;
}

export const bulkyPayloadTruncator: SpanOutputProcessor = {
  name: 'bulky-payload-truncator',
  process(span?: AnySpan): AnySpan | undefined {
    if (span && BULKY_SPAN_TYPES.has(span.type)) {
      span.input = truncatePayload(span.input);
      span.output = truncatePayload(span.output);
    }
    return span;
  },
  shutdown: async () => {},
};
