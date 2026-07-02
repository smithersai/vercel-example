// SummarySchema per docs/planning/03-eng.md §1 and E13 (sparse-window shape amendment):
// window, topics[1-7] with participants, decisions, actionItems, links.
export const SummarySchema = {
  name: 'summary',
  description: 'A structured summary of a chat conversation window.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['window', 'topics'],
    properties: {
      window: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
        },
      },
      topics: {
        type: 'array',
        minItems: 1,
        maxItems: 7,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'participants', 'decisions', 'actionItems', 'links'],
          properties: {
            title: { type: 'string' },
            participants: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            actionItems: { type: 'array', items: { type: 'string' } },
            links: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

export function validateAgainstSchema(obj) {
  const errors = [];
  if (typeof obj !== 'object' || obj === null) {
    return { valid: false, errors: ['root is not an object'] };
  }
  if (!obj.window || typeof obj.window !== 'object') errors.push('missing window');
  else {
    if (typeof obj.window.start !== 'string') errors.push('window.start not string');
    if (typeof obj.window.end !== 'string') errors.push('window.end not string');
  }
  if (!Array.isArray(obj.topics)) {
    errors.push('missing topics array');
  } else {
    if (obj.topics.length < 1 || obj.topics.length > 7) {
      errors.push(`topics.length ${obj.topics.length} out of [1,7]`);
    }
    obj.topics.forEach((t, i) => {
      if (typeof t !== 'object' || t === null) {
        errors.push(`topics[${i}] not object`);
        return;
      }
      if (typeof t.title !== 'string') errors.push(`topics[${i}].title not string`);
      for (const field of ['participants', 'decisions', 'actionItems', 'links']) {
        if (!Array.isArray(t[field])) errors.push(`topics[${i}].${field} not array`);
        else if (!t[field].every((x) => typeof x === 'string')) {
          errors.push(`topics[${i}].${field} has non-string entries`);
        }
      }
    });
  }
  return { valid: errors.length === 0, errors };
}
