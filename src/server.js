import { createDb } from './db.js';
import { createApp } from './app.js';
import { makeLlm } from './query.js';
const secret = process.env.SESSION_SECRET;
if (!secret) { console.error('Set SESSION_SECRET (see .env.example)'); process.exit(1); }
const db = createDb(process.env.DB_PATH || './erp.db', process.env.DEMO_PASSWORD || 'demo-pass-1');
createApp(db, secret, { llm: process.env.ANTHROPIC_API_KEY ? makeLlm(process.env.ANTHROPIC_API_KEY, process.env.ASSISTANT_MODEL) : null }).listen(process.env.PORT || 3000, () => console.log('ERP API up'));
