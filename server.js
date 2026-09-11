const http = require('http');
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 10000);
const SESSION_SECRET = process.env.SESSION_SECRET || 'poolvault-local-development-secret';
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true, limit:'1mb'}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : new Error('Comprovante deve ser imagem ou PDF.'), ok);
  }
});

// ---------------------------------------------------------------------------
// Data layer: PostgreSQL in Render, in-memory fallback for local smoke tests.
// ---------------------------------------------------------------------------
let pool = null;
const mem = { users: [], accounts: [], memberships: [], records: [], sessions: [] };
let seq = { users: 1, accounts: 1, memberships: 1, records: 1 };

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProd ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000
  });
  pool.on('error', err => console.error('[postgres]', err.message));
}

async function dbQuery(text, params=[]) {
  if (!pool) throw new Error('DATABASE_NOT_CONFIGURED');
  return pool.query(text, params);
}

async function initDb() {
  if (!pool) return;
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone_digits CHAR(4) NOT NULL,
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code VARCHAR(12) NOT NULL UNIQUE,
      created_by BIGINT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS memberships (
      id BIGSERIAL PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(account_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS records (
      id BIGSERIAL PRIMARY KEY,
      account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id),
      type VARCHAR(12) NOT NULL CHECK(type IN ('deposit','withdraw')),
      amount NUMERIC(14,2) NOT NULL CHECK(amount > 0),
      bank TEXT,
      description TEXT,
      receipt BYTEA,
      receipt_name TEXT,
      receipt_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS idx_records_account_date ON records(account_id, created_at DESC);
  `);
  // Safe compatibility additions for older databases.
  await dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
  await dbQuery(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS code VARCHAR(12)`);
}

function nextId(kind) { return seq[kind]++; }
function now() { return new Date().toISOString(); }
function cleanName(v) { return String(v || '').trim().replace(/\s+/g,' '); }
function digits4(v) { return String(v || '').replace(/\D/g,'').slice(-4); }
function money(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n*100)/100 : NaN; }
function accountCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }
function signToken(id) {
  const payload = `${id}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function verifyToken(token) {
  try {
    const raw = Buffer.from(token,'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const [id,ts,sig] = parts;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${id}.${ts}`).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    if (Date.now() - Number(ts) > 1000*60*60*24*30) return null;
    return Number(id);
  } catch { return null; }
}
function setSession(res,userId) {
  const token = signToken(userId);
  res.cookie('pv_session', token, {httpOnly:true, sameSite:'lax', secure:isProd, maxAge:1000*60*60*24*30, path:'/'});
  // Also return a header token for environments where cookie handling is restricted.
  res.setHeader('X-Poolvault-Session', token);
  return token;
}
function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach(x=>{const i=x.indexOf('='); if(i>0) out[x.slice(0,i).trim()] = decodeURIComponent(x.slice(i+1));});
  return out;
}
async function authUser(req,res,next) {
  const token = parseCookies(req).pv_session || req.headers['x-poolvault-session'] || '';
  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ok:false,error:'Sessão expirada. Faça login novamente.'});
  const user = await getUser(userId);
  if (!user) return res.status(401).json({ok:false,error:'Usuário não encontrado.'});
  req.user = user;
  next();
}

async function getUser(id) {
  if (pool) {
    const r = await dbQuery('SELECT id,name,phone_digits AS "phoneDigits",created_at AS "createdAt" FROM users WHERE id=$1',[id]);
    return r.rows[0] || null;
  }
  return mem.users.find(x=>x.id===id) || null;
}
async function getAccountForUser(userId) {
  if (pool) {
    const r = await dbQuery(`SELECT a.id,a.name,a.code FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=$1 ORDER BY a.id LIMIT 1`,[userId]);
    return r.rows[0] || null;
  }
  const m=mem.memberships.find(x=>x.userId===userId); return m ? mem.accounts.find(a=>a.id===m.accountId) : null;
}
async function getMembers(accountId) {
  if (pool) {
    const r=await dbQuery(`SELECT u.id,u.name,u.phone_digits AS "phoneDigits",u.created_at AS "createdAt" FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.account_id=$1 ORDER BY u.name`,[accountId]);
    return r.rows;
  }
  const ids=mem.memberships.filter(m=>m.accountId===accountId).map(m=>m.userId); return mem.users.filter(u=>ids.includes(u.id));
}
async function getRecords(accountId, limit=100) {
  if (pool) {
    const r=await dbQuery(`SELECT r.id,r.type,r.amount::float AS amount,r.bank,r.description,r.created_at AS "createdAt",r.user_id AS "userId",u.name AS "userName",r.receipt IS NOT NULL AS "hasReceipt",r.receipt_name AS "receiptName",r.receipt_type AS "receiptType" FROM records r JOIN users u ON u.id=r.user_id WHERE r.account_id=$1 ORDER BY r.created_at DESC LIMIT $2`,[accountId,limit]);
    return r.rows;
  }
  return mem.records.filter(r=>r.accountId===accountId).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,limit).map(r=>({...r,userName:mem.users.find(u=>u.id===r.userId)?.name||'Usuário',hasReceipt:!!r.receipt}));
}
async function totals(accountId) {
  if (pool) {
    const r=await dbQuery(`SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)::float AS balance, COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE 0 END),0)::float AS deposits, COALESCE(SUM(CASE WHEN type='withdraw' THEN amount ELSE 0 END),0)::float AS withdrawals FROM records WHERE account_id=$1`,[accountId]);
    return r.rows[0];
  }
  const rs=mem.records.filter(r=>r.accountId===accountId); return {balance:rs.reduce((s,r)=>s+(r.type==='deposit'?r.amount:-r.amount),0),deposits:rs.filter(r=>r.type==='deposit').reduce((s,r)=>s+r.amount,0),withdrawals:rs.filter(r=>r.type==='withdraw').reduce((s,r)=>s+r.amount,0)};
}
async function userTotal(accountId,userId) {
  if (pool) { const r=await dbQuery(`SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)::float AS balance FROM records WHERE account_id=$1 AND user_id=$2`,[accountId,userId]); return r.rows[0].balance; }
  return mem.records.filter(r=>r.accountId===accountId&&r.userId===userId).reduce((s,r)=>s+(r.type==='deposit'?r.amount:-r.amount),0);
}

const sockets = new Map();
function broadcast(accountId, payload) {
  const set=sockets.get(String(accountId)); if(!set) return;
  const msg=JSON.stringify(payload);
  for(const ws of set) if(ws.readyState===1) ws.send(msg);
}

app.get('/api/health', async (_req,res)=>{
  let db='memory';
  if(pool){ try { await dbQuery('SELECT 1'); db='postgres'; } catch { db='postgres-unavailable'; } }
  res.json({ok:true,db,persistent:!!pool,time:new Date().toISOString()});
});

app.get('/api/session', async (req,res)=>{
  try {
    const token=parseCookies(req).pv_session || req.headers['x-poolvault-session'] || '';
    const id=verifyToken(token); if(!id) return res.json({ok:true,authenticated:false});
    const user=await getUser(id); if(!user) return res.json({ok:true,authenticated:false});
    const account=await getAccountForUser(id); res.json({ok:true,authenticated:true,user,account});
  } catch(e){ res.status(500).json({ok:false,error:'Falha ao recuperar sessão.'}); }
});

app.post('/api/auth/signup', async (req,res)=>{
  const name=cleanName(req.body.name); const phoneDigits=digits4(req.body.phoneDigits);
  if(name.length<3) return res.status(400).json({ok:false,error:'Informe seu nome completo.'});
  if(phoneDigits.length!==4) return res.status(400).json({ok:false,error:'Informe os 4 últimos dígitos do celular.'});
  try {
    let user,account;
    if(pool){
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const ur=await client.query(`INSERT INTO users(name,phone_digits) VALUES($1,$2) RETURNING id,name,phone_digits AS "phoneDigits",created_at AS "createdAt"`,[name,phoneDigits]);
        user=ur.rows[0];
        const ar=await client.query(`INSERT INTO accounts(name,code,created_by) VALUES($1,$2,$3) RETURNING id,name,code`,[`Conta de ${name.split(' ')[0]}`,accountCode(),user.id]);
        account=ar.rows[0];
        await client.query(`INSERT INTO memberships(account_id,user_id) VALUES($1,$2)`,[account.id,user.id]);
        await client.query('COMMIT');
      } catch(e){ await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } else {
      user={id:nextId('users'),name,phoneDigits,createdAt:now()}; mem.users.push(user);
      account={id:nextId('accounts'),name:`Conta de ${name.split(' ')[0]}`,code:accountCode(),createdBy:user.id,createdAt:now()}; mem.accounts.push(account);
      mem.memberships.push({id:nextId('memberships'),accountId:account.id,userId:user.id,joinedAt:now()});
    }
    const token=setSession(res,user.id);
    res.status(201).json({ok:true,user,profile:user,account,session:token});
  } catch(e){
    console.error('[signup]',e);
    res.status(500).json({ok:false,error:'Não foi possível criar o perfil. Verifique o PostgreSQL do Render.',detail:isProd?undefined:e.message});
  }
});

app.post('/api/auth/login', async (req,res)=>{
  const name=cleanName(req.body.name); const phoneDigits=digits4(req.body.phoneDigits);
  if(phoneDigits.length!==4) return res.status(400).json({ok:false,error:'Informe os 4 últimos dígitos.'});
  try{
    let user;
    if(pool){const r=await dbQuery(`SELECT id,name,phone_digits AS "phoneDigits",created_at AS "createdAt" FROM users WHERE phone_digits=$1 AND LOWER(name)=LOWER($2) LIMIT 1`,[phoneDigits,name]); user=r.rows[0];}
    else user=mem.users.find(u=>u.phoneDigits===phoneDigits && u.name.toLowerCase()===name.toLowerCase());
    if(!user) return res.status(401).json({ok:false,error:'Perfil não encontrado. Confira nome e os 4 últimos dígitos.'});
    const account=await getAccountForUser(user.id); setSession(res,user.id); res.json({ok:true,user,profile:user,account});
  }catch(e){console.error('[login]',e);res.status(500).json({ok:false,error:'Falha ao acessar o sistema.'});}
});

app.post('/api/auth/logout',(req,res)=>{res.setHeader('Set-Cookie','pv_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');res.json({ok:true});});

app.get('/api/state',authUser,async(req,res)=>{
  try{
    const account=await getAccountForUser(req.user.id); if(!account) return res.status(404).json({ok:false,error:'Conta conjunta não encontrada.'});
    const [members,records,totalsData,individual]=await Promise.all([getMembers(account.id),getRecords(account.id),totals(account.id),userTotal(account.id,req.user.id)]);
    res.json({ok:true,user:req.user,account,members,records,totals:totalsData,individualBalance:individual});
  }catch(e){console.error('[state]',e);res.status(500).json({ok:false,error:'Não foi possível carregar os dados.'});}
});

app.post('/api/accounts/join',authUser,async(req,res)=>{
  const code=String(req.body.code||'').trim().toUpperCase(); if(!code) return res.status(400).json({ok:false,error:'Informe o código da conta.'});
  try{
    if(pool){const a=await dbQuery('SELECT id,name,code FROM accounts WHERE code=$1',[code]); if(!a.rows[0]) return res.status(404).json({ok:false,error:'Conta não encontrada.'}); await dbQuery('INSERT INTO memberships(account_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[a.rows[0].id,req.user.id]); broadcast(a.rows[0].id,{type:'members_changed'}); return res.json({ok:true,account:a.rows[0]});}
    const a=mem.accounts.find(x=>x.code===code); if(!a)return res.status(404).json({ok:false,error:'Conta não encontrada.'}); if(!mem.memberships.some(m=>m.accountId===a.id&&m.userId===req.user.id)) mem.memberships.push({id:nextId('memberships'),accountId:a.id,userId:req.user.id,joinedAt:now()}); broadcast(a.id,{type:'members_changed'}); res.json({ok:true,account:a});
  }catch(e){res.status(500).json({ok:false,error:'Não foi possível entrar na conta.'});}
});

app.post('/api/records',authUser,upload.single('receipt'),async(req,res)=>{
  const type=req.body.type==='withdraw'?'withdraw':'deposit'; const amount=money(req.body.amount); const bank=String(req.body.bank||'').trim(); const description=String(req.body.description||'').trim();
  if(!Number.isFinite(amount)||amount<=0)return res.status(400).json({ok:false,error:'Informe um valor válido.'});
  try{
    const account=await getAccountForUser(req.user.id); if(!account)return res.status(400).json({ok:false,error:'Você ainda não pertence a uma conta conjunta.'});
    if(pool){
      const r=await dbQuery(`INSERT INTO records(account_id,user_id,type,amount,bank,description,receipt,receipt_name,receipt_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,type,amount::float AS amount,bank,description,created_at AS "createdAt",user_id AS "userId",(receipt IS NOT NULL) AS "hasReceipt"`,[account.id,req.user.id,type,amount,bank,description,req.file?.buffer||null,req.file?.originalname||null,req.file?.mimetype||null]);
      const record={...r.rows[0],userName:req.user.name}; broadcast(account.id,{type:'record_created',record}); return res.status(201).json({ok:true,record});
    }
    const record={id:nextId('records'),accountId:account.id,userId:req.user.id,type,amount,bank,description,receipt:req.file?{buffer:req.file.buffer,name:req.file.originalname,type:req.file.mimetype}:null,createdAt:now()}; mem.records.push(record); const out={...record,userName:req.user.name,hasReceipt:!!record.receipt}; broadcast(account.id,{type:'record_created',record:out}); res.status(201).json({ok:true,record:out});
  }catch(e){console.error('[record]',e);res.status(500).json({ok:false,error:'Não foi possível registrar o movimento.'});}
});

app.get('/api/records/:id/receipt',authUser,async(req,res)=>{
  try{
    const account=await getAccountForUser(req.user.id); if(!account)return res.sendStatus(404);
    if(pool){const r=await dbQuery('SELECT receipt,receipt_name,receipt_type FROM records WHERE id=$1 AND account_id=$2',[req.params.id,account.id]); if(!r.rows[0]?.receipt)return res.sendStatus(404); res.setHeader('Content-Type',r.rows[0].receipt_type||'application/octet-stream');res.setHeader('Content-Disposition',`inline; filename="${String(r.rows[0].receipt_name||'comprovante').replace(/"/g,'')}"`);return res.end(r.rows[0].receipt);}
    const r=mem.records.find(x=>x.id===Number(req.params.id)&&x.accountId===account.id);if(!r?.receipt)return res.sendStatus(404);res.setHeader('Content-Type',r.receipt.type);return res.end(r.receipt.buffer);
  }catch(e){res.sendStatus(500);}
});

// Serve the three frontend files from project root. No public/ directory.
app.get('/styles.css',(_req,res)=>res.sendFile(require('path').join(__dirname,'styles.css')));
app.get('/app.js',(_req,res)=>res.sendFile(require('path').join(__dirname,'app.js')));
app.get('/',(_req,res)=>res.sendFile(require('path').join(__dirname,'index.html')));
app.get(/.*/,(req,res)=>{ if(req.path.startsWith('/api/')) return res.status(404).json({ok:false,error:'Rota não encontrada.'}); res.sendFile(require('path').join(__dirname,'index.html')); });

app.use((err,_req,res,_next)=>{console.error('[error]',err);res.status(400).json({ok:false,error:err.message||'Erro inesperado.'});});

const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',async(ws,req)=>{
  try{
    const u=new URL(req.url,'http://localhost'); const token=u.searchParams.get('token') || ''; const uid=verifyToken(token); if(!uid){ws.close(1008,'unauthorized');return;}
    const account=await getAccountForUser(uid); if(!account){ws.close(1008,'no-account');return;}
    const key=String(account.id); if(!sockets.has(key))sockets.set(key,new Set()); sockets.get(key).add(ws);
    ws.send(JSON.stringify({type:'connected',accountId:account.id}));
    ws.on('close',()=>{const set=sockets.get(key);if(set){set.delete(ws);if(!set.size)sockets.delete(key);}});
  }catch{ws.close(1011,'server-error');}
});

server.listen(PORT,'0.0.0.0',()=>console.log(`Poolvault running on 0.0.0.0:${PORT} | postgres=${!!pool}`));

(async()=>{if(pool){try{await initDb();console.log('PostgreSQL schema ready.')}catch(e){console.error('PostgreSQL unavailable at startup:',e.message)}}})();
