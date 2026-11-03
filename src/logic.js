// Fixed, auditable rules. No AI decides attendance or marks (brief: "fixed settings").
export const RULES = { minAttendance: 75, lowMarksRatio: 0.5, trendDrop: 20 };
export const COMPONENTS = { mid1: 20, mid2: 10, assignment: 10 }; // internal = 40

export const pct = (p, t) => (t ? Math.round((p / t) * 1000) / 10 : 0);

// At-risk flag from attendance and marks trend. Returns reasons; never mutates records.
export function atRisk({ attPct, marks }) {
  const reasons = [];
  if (attPct != null && attPct < RULES.minAttendance) reasons.push(`Attendance ${attPct}% is below ${RULES.minAttendance}%`);
  const total = Object.values(marks).reduce((a, m) => a + m.score, 0);
  const max = Object.values(marks).reduce((a, m) => a + m.max, 0);
  if (max && total / max < RULES.lowMarksRatio) reasons.push(`Internal marks ${total}/${max} are below 50%`);
  if (marks.mid1 && marks.mid2) {
    const drop = (marks.mid1.score / marks.mid1.max - marks.mid2.score / marks.mid2.max) * 100;
    if (drop >= RULES.trendDrop) reasons.push(`Marks fell ${Math.round(drop)} points from Mid 1 to Mid 2`);
  }
  return reasons;
}

export function validateRecord(r) {
  if (!r || typeof r.client_id !== 'string' || !/^[\w-]{8,64}$/.test(r.client_id)) return 'bad client_id';
  if (typeof r.roll !== 'string' || r.roll.length > 32) return 'bad roll';
  if (!Number.isInteger(r.subject_id)) return 'bad subject_id';
  if (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || isNaN(Date.parse(r.date))) return 'bad date';
  if (!Number.isInteger(r.period) || r.period < 1 || r.period > 8) return 'bad period';
  if (typeof r.present !== 'boolean') return 'bad present';
  return null;
}

// Admissions import. Roll format follows the brief's samples; the prefix map is an assumption.
export const PROGRAMMES = { 'B.Tech CSE': ['ENG', 'CSE'], 'B.Tech Mechanical': ['ENG', 'ME'], MBA: ['MBA', null] };
export const ageOn = (dob, now = new Date()) => { const d = new Date(dob); let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--; return a; };
export function parseApplicants(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = (lines.shift() || '').toLowerCase().split(',').map((x) => x.trim());
  const need = ['name', 'dob', 'programme', 'year', 'guardian_consent'];
  if (need.some((n) => !head.includes(n))) return { error: 'Header must be: ' + need.join(',') };
  return { rows: lines.map((l) => { const c = l.split(',').map((x) => x.trim()); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])); }) };
}

// Staff leave. ASSUMPTION: 12 leave days per calendar year, counted as calendar days inclusive.
export const LEAVE = { annualDays: 12, types: ['casual', 'medical', 'earned'] };
export const leaveDays = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
export function validateLeave(b) {
  const iso = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
  if (!b || !LEAVE.types.includes(b.type) || !iso(b.from) || !iso(b.to)) return 'Choose a type and valid dates';
  if (b.to < b.from) return 'End date is before start date';
  if (b.from.slice(0, 4) !== b.to.slice(0, 4)) return 'Split leave that crosses a year into two requests';
  if (typeof b.reason !== 'string' || b.reason.trim().length < 3 || b.reason.length > 200) return 'Give a reason of 3 to 200 characters';
  return null;
}
