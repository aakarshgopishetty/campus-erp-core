// Plain-English questions -> a validated filter spec -> fixed in-code filtering.
// The model never writes SQL. It can only pick from whitelisted fields and operators,
// so the assistant is read-only by construction.
const OPS = ['<', '<=', '>', '>=', '='];
const NUM = ['attendance', 'year', 'fee_due', 'marks_total'];

export function validate(spec, programmes) {
  if (!spec || !Array.isArray(spec.filters) || spec.filters.length > 5) return null;
  const out = [];
  for (const f of spec.filters) {
    if (!f || !OPS.includes(f.op)) return null;
    if (f.field === 'programme') { if (f.op !== '=' || !programmes.includes(f.value)) return null; }
    else if (!NUM.includes(f.field) || typeof f.value !== 'number' || !Number.isFinite(f.value) || Math.abs(f.value) > 1e7) return null;
    out.push({ field: f.field, op: f.op, value: f.value });
  }
  return out;
}

const YEARS = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };
export function ruleParse(q, programmes) {
  const t = q.toLowerCase(), f = [];
  const below = t.match(/(?:below|under|less than|<)\s*(\d+(?:\.\d+)?)\s*%/), above = t.match(/(?:above|over|more than|>)\s*(\d+(?:\.\d+)?)\s*%/);
  if (below) f.push({ field: 'attendance', op: '<', value: +below[1] });
  if (above) f.push({ field: 'attendance', op: '>', value: +above[1] });
  const mk = t.match(/marks?\s*(?:below|under|less than|<)\s*(\d+)/);
  if (mk) f.push({ field: 'marks_total', op: '<', value: +mk[1] });
  const y = t.match(/(first|second|third|fourth|1st|2nd|3rd|4th)[- ]year/) || t.match(/year\s*(\d)/);
  if (y) f.push({ field: 'year', op: '=', value: YEARS[y[1]] ?? +y[1] });
  if (/\b(fees?|dues?|owe|owing|pending)\b/.test(t)) f.push({ field: 'fee_due', op: '>', value: 0 });
  for (const p of programmes) if (t.includes(p.toLowerCase().split(' ').pop())) f.push({ field: 'programme', op: '=', value: p });
  return { filters: f };
}

export function makeLlm(key, model = 'claude-haiku-5-5') {
  return async (q, programmes) => {
    const sys = `Convert a question about students into JSON only: {"filters":[{"field":"attendance|year|fee_due|marks_total|programme","op":"<|<=|>|>=|=","value":<number, or a programme name for programme>}]}. Programmes: ${JSON.stringify(programmes)}. attendance is a percent, marks_total is out of 40. No prose, no code fences.`;
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 300, system: sys, messages: [{ role: 'user', content: q }] }) });
    if (!r.ok) throw new Error('llm ' + r.status);
    const j = await r.json();
    return JSON.parse(j.content.map((c) => c.text || '').join('').replace(/```json|```/g, '').trim());
  };
}
