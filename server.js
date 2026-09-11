'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 10000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'poolvault-development-secret-change-me';
const isProd = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/i.test(file.mimetype);
    cb(allowed ? null : new Error('Comprovante deve ser imagem ou PDF.'), allowed);
  }
});

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : undefined,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
}) : null;

if (pool) pool.on('error', err => console.error('[postgres]', err));

let dbReady;
if (pool) {
  dbReady = initDb();
} else {
  dbReady = Promise.resolve();
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        phone_digits VARCHAR(4) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        code VARCHAR(12) NOT NULL UNIQUE,
        created_by BIGINT NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS memberships (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(account_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS records (
        id BIGSERIAL PRIMARY KEY,
        account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES users(id),
        type VARCHAR(3) NOT NULL CHECK(type IN ('dep','wit')),
        amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
        bank TEXT,
        description TEXT,
        receipt BYTEA,
        receipt_name TEXT,
        receipt_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships(account_id);
      CREATE INDEX IF NOT EXISTS idx_records_account_created ON records(account_id, created_at DESC);
    `);
    await client.query('COMMIT');
    console.log('[db] PostgreSQL schema ready');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[db] schema initialization failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function requireDatabase() {
  if (!pool) throw Object.assign(new Error('DATABASE_URL não está configurada no Render.'), { code: 'DATABASE_NOT_CONFIGURED' });
  await dbReady;
}

function cleanName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function digits4(value) { return String(value || '').replace(/\D/g, '').slice(-4); }
function amount(value) { const n = Number(value); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; }
function code() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }
function tokenFor(userId) {
  const payload = `${userId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function verifyToken(token) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    const [id, timestamp, signature] = raw.split('.');
    if (!id || !timestamp || !signature) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${id}.${timestamp}`).digest('hex');
    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    if (!Number.isFinite(Number(timestamp)) || Date.now() - Number(timestamp) > 30 * 24 * 60 * 60 * 1000) return null;
    return Number(id);
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  });
  return out;
}
function setSession(res, userId) {
  const token = tokenFor(userId);
  const flags = `Path=/; Max-Age=${30 * 24 * 60 * 60}; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `pv_session=${encodeURIComponent(token)}; ${flags}`);
  return token;
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `pv_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`);
}
function requestUserId(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies.pv_session || req.headers['x-poolvault-session'] || '');
}

async function getUser(id) {
  const r = await pool.query(`SELECT id,name,phone_digits AS "phoneDigits",created_at AS "createdAt" FROM users WHERE id=$1`, [id]);
  return r.rows[0] || null;
}
async function getAccount(userId) {
  const r = await pool.query(`SELECT a.id,a.name,a.code FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=$1 ORDER BY a.id LIMIT 1`, [userId]);
  return r.rows[0] || null;
}
async function getMembers(accountId) {
  const r = await pool.query(`SELECT u.id,u.name,u.phone_digits AS "phoneDigits",u.created_at AS "createdAt",m.joined_at AS "joinedAt",m.id AS "membershipId",m.user_id AS "userId" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.account_id=$1 ORDER BY u.name`, [accountId]);
  return r.rows;
}
async function getRecords(accountId) {
  const r = await pool.query(`SELECT r.id,r.type,r.amount::float AS amount,r.bank,r.description,r.created_at AS "createdAt",r.user_id AS "userId",u.name AS "userName",(r.receipt IS NOT NULL) AS "hasReceipt" FROM records r JOIN users u ON u.id=r.user_id WHERE r.account_id=$1 ORDER BY r.created_at DESC LIMIT 200`, [accountId]);
  return r.rows;
}
async function getTotals(accountId, userId) {
  const [total, personal] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(CASE WHEN type='dep' THEN amount ELSE 0 END),0)::float AS dep, COALESCE(SUM(CASE WHEN type='wit' THEN amount ELSE 0 END),0)::float AS wit FROM records WHERE account_id=$1`, [accountId]),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN type='dep' THEN amount ELSE -amount END),0)::float AS balance FROM records WHERE account_id=$1 AND user_id=$2`, [accountId, userId])
  ]);
  const dep = Number(total.rows[0].dep || 0);
  const wit = Number(total.rows[0].wit || 0);
  return { dep, wit, balance: dep - wit, individualBalance: Number(personal.rows[0].balance || 0) };
}

async function auth(req, res, next) {
  try {
    await requireDatabase();
    const userId = requestUserId(req);
    if (!userId) return res.status(401).json({ ok:false, error:'Sessão não encontrada. Faça login novamente.' });
    const user = await getUser(userId);
    if (!user) return res.status(401).json({ ok:false, error:'Perfil não encontrado.' });
    req.user = user;
    next();
  } catch (err) {
    console.error('[auth]', err);
    res.status(503).json({ ok:false, error:'Banco de dados indisponível. Verifique a conexão PostgreSQL do Render.' });
  }
}

app.get('/api/health', async (_req, res) => {
  if (!pool) return res.status(503).json({ ok:false, db:'not-configured', persistent:false });
  try { await dbReady; await pool.query('SELECT 1'); res.json({ ok:true, db:'postgres', persistent:true }); }
  catch (err) { res.status(503).json({ ok:false, db:'postgres-error', persistent:true, error: err.message }); }
});

app.get('/api/session', async (req, res) => {
  if (!pool) return res.json({ ok:true, authenticated:false });
  try {
    await dbReady;
    const userId = requestUserId(req);
    if (!userId) return res.json({ ok:true, authenticated:false });
    const user = await getUser(userId);
    const account = user ? await getAccount(user.id) : null;
    if (!user || !account) return res.json({ ok:true, authenticated:false });
    res.json({ ok:true, authenticated:true, user, profile:user, account });
  } catch (err) {
    console.error('[session]', err);
    res.status(503).json({ ok:false, error:'Banco de dados indisponível.' });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const name = cleanName(req.body.name);
  const phoneDigits = digits4(req.body.phoneDigits);
  if (name.split(/\s+/).length < 2) return res.status(400).json({ ok:false, error:'Informe nome e sobrenome.' });
  if (!/^\d{4}$/.test(phoneDigits)) return res.status(400).json({ ok:false, error:'Informe os 4 últimos dígitos do celular.' });

  let client;
  try {
    await requireDatabase();
    client = await pool.connect();
    await client.query('BEGIN');
    const userResult = await client.query(`INSERT INTO users(name,phone_digits) VALUES($1,$2) RETURNING id,name,phone_digits AS "phoneDigits",created_at AS "createdAt"`, [name, phoneDigits]);
    const user = userResult.rows[0];
    const accountResult = await client.query(`INSERT INTO accounts(name,code,created_by) VALUES($1,$2,$3) RETURNING id,name,code`, [`Conta de ${name.split(' ')[0]}`, code(), user.id]);
    const account = accountResult.rows[0];
    await client.query(`INSERT INTO memberships(account_id,user_id) VALUES($1,$2)`, [account.id, user.id]);
    await client.query('COMMIT');
    const session = setSession(res, user.id);
    console.log(`[signup] perfil=${user.id} conta=${account.id}`);
    return res.status(201).json({ ok:true, user, profile:user, account, session });
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('[signup]', err);
    const message = err.code === 'DATABASE_NOT_CONFIGURED' ? 'DATABASE_URL não está configurada no Render.' : 'Não foi possível criar o perfil no PostgreSQL.';
    return res.status(err.code === 'DATABASE_NOT_CONFIGURED' ? 503 : 500).json({ ok:false, error:message });
  } finally { if (client) client.release(); }
});

app.post('/api/auth/login', async (req, res) => {
  const phoneDigits = digits4(req.body.phoneDigits);
  if (!/^\d{4}$/.test(phoneDigits)) return res.status(400).json({ ok:false, error:'Informe os 4 últimos dígitos.' });
  try {
    await requireDatabase();
    const r = await pool.query(`SELECT id,name,phone_digits AS "phoneDigits",created_at AS "createdAt" FROM users WHERE phone_digits=$1 ORDER BY created_at DESC LIMIT 1`, [phoneDigits]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ ok:false, error:'Perfil não encontrado. Cadastre-se primeiro.' });
    const account = await getAccount(user.id);
    if (!account) return res.status(409).json({ ok:false, error:'Seu perfil não possui uma conta conjunta.' });
    const session = setSession(res, user.id);
    res.json({ ok:true, user, profile:user, account, session });
  } catch (err) {
    console.error('[login]', err);
    res.status(503).json({ ok:false, error:'Banco de dados indisponível.' });
  }
});

app.post('/api/auth/logout', (req, res) => { clearSession(res); res.json({ ok:true }); });

app.get('/api/state', auth, async (req, res) => {
  try {
    const account = await getAccount(req.user.id);
    if (!account) return res.status(404).json({ ok:false, error:'Conta conjunta não encontrada.' });
    const [members, records, totals] = await Promise.all([getMembers(account.id), getRecords(account.id), getTotals(account.id, req.user.id)]);
    res.json({ ok:true, user:req.user, account, members, records, totals:{ dep:totals.dep, wit:totals.wit, balance:totals.balance }, individualBalance:totals.individualBalance });
  } catch (err) { console.error('[state]', err); res.status(500).json({ ok:false, error:'Não foi possível carregar os dados.' }); }
});

app.post('/api/accounts/join', auth, async (req, res) => {
  const accountCode = String(req.body.code || '').trim().toUpperCase();
  if (!accountCode) return res.status(400).json({ ok:false, error:'Informe o código da conta.' });
  try {
    const accountResult = await pool.query(`SELECT id,name,code FROM accounts WHERE code=$1`, [accountCode]);
    const account = accountResult.rows[0];
    if (!account) return res.status(404).json({ ok:false, error:'Conta não encontrada.' });
    await pool.query(`INSERT INTO memberships(account_id,user_id) VALUES($1,$2) ON CONFLICT(account_id,user_id) DO NOTHING`, [account.id, req.user.id]);
    broadcast(account.id, { type:'members_changed' });
    res.json({ ok:true, account });
  } catch (err) { console.error('[join]', err); res.status(500).json({ ok:false, error:'Não foi possível entrar na conta.' }); }
});

app.post('/api/records', auth, upload.single('receipt'), async (req, res) => {
  const type = req.body.type === 'wit' ? 'wit' : 'dep';
  const value = amount(req.body.amount);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ ok:false, error:'Informe um valor válido.' });
  try {
    const account = await getAccount(req.user.id);
    if (!account) return res.status(404).json({ ok:false, error:'Conta conjunta não encontrada.' });
    const r = await pool.query(`INSERT INTO records(account_id,user_id,type,amount,bank,description,receipt,receipt_name,receipt_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,type,amount::float AS amount,bank,description,created_at AS "createdAt",user_id AS "userId",(receipt IS NOT NULL) AS "hasReceipt"`, [account.id, req.user.id, type, value, String(req.body.bank || '').trim(), String(req.body.description || '').trim(), req.file?.buffer || null, req.file?.originalname || null, req.file?.mimetype || null]);
    const record = { ...r.rows[0], userName:req.user.name };
    broadcast(account.id, { type:'record_created', record });
    res.status(201).json({ ok:true, record });
  } catch (err) { console.error('[record]', err); res.status(500).json({ ok:false, error:'Não foi possível registrar a movimentação.' }); }
});

app.get('/api/records/:id/receipt', auth, async (req, res) => {
  try {
    const account = await getAccount(req.user.id);
    const r = await pool.query(`SELECT receipt,receipt_name,receipt_type FROM records WHERE id=$1 AND account_id=$2`, [req.params.id, account?.id]);
    if (!r.rows[0] || !r.rows[0].receipt) return res.sendStatus(404);
    res.setHeader('Content-Type', r.rows[0].receipt_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(r.rows[0].receipt_name || 'comprovante').replace(/"/g, '')}"`);
    res.end(r.rows[0].receipt);
  } catch (err) { console.error('[receipt]', err); res.sendStatus(500); }
});

app.get('/styles.css', (_req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/manifest.webmanifest', (_req, res) => res.sendFile(path.join(__dirname, 'manifest.webmanifest')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(/^\/(?!api\/|styles\.css$|app\.js$|manifest\.webmanifest$).*/, (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error('[http]', err);
  res.status(400).json({ ok:false, error:err.message || 'Erro inesperado.' });
});

const sockets = new Map();
function broadcast(accountId, payload) {
  const set = sockets.get(String(accountId));
  if (!set) return;
  const message = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(message);
}

const wss = new WebSocketServer({ server, path:'/ws' });
wss.on('connection', async (ws, req) => {
  try {
    await requireDatabase();
    const url = new URL(req.url, 'http://localhost');
    const userId = verifyToken(url.searchParams.get('token'));
    if (!userId) return ws.close(1008, 'unauthorized');
    const account = await getAccount(userId);
    if (!account) return ws.close(1008, 'no-account');
    const key = String(account.id);
    if (!sockets.has(key)) sockets.set(key, new Set());
    sockets.get(key).add(ws);
    ws.send(JSON.stringify({ type:'connected', accountId:account.id }));
    ws.on('close', () => {
      const set = sockets.get(key);
      if (!set) return;
      set.delete(ws);
      if (!set.size) sockets.delete(key);
    });
  } catch { ws.close(1011, 'server-error'); }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Poolvault listening on 0.0.0.0:${PORT}`));
