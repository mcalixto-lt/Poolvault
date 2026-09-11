import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import pg from 'pg';
import { WebSocketServer } from 'ws';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'poolvault-development-secret';
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const USE_PG = Boolean(DATABASE_URL);
const pool = USE_PG ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000
}) : null;
const app = express();
const server = http.createServer(app);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });
const memory = { users:new Map(), accounts:new Map(), memberships:new Map(), records:new Map(), proofs:new Map() };
const clients = new Map();
let dbMode = USE_PG ? 'postgres' : 'memory';
let schemaPromise = null;

app.disable('x-powered-by');
app.use(express.json({limit:'200kb'}));
app.use(cookieParser());

// Frontend files intentionally live at the project root (no public/ folder).
for (const file of ['index.html','styles.css','app.js','manifest.webmanifest','service-worker.js']) {
  app.get('/'+file, (req,res)=>res.sendFile(path.join(ROOT,file)));
}
app.get('/', (req,res)=>res.sendFile(path.join(ROOT,'index.html')));

const uid=()=>crypto.randomUUID();
const cleanName=s=>String(s??'').trim().replace(/\s+/g,' ');
const shortName=n=>cleanName(n).split(' ')[0] || 'usuário';
const initial=n=>(shortName(n)[0]||'P').toUpperCase();
const code=()=>crypto.randomBytes(4).toString('hex').toUpperCase();
const err=(res,status,message,details='')=>res.status(status).json({ok:false,error:message,details});
function token(user){return jwt.sign({sub:user.id},JWT_SECRET,{expiresIn:'30d'});}
function setAuth(res,user){res.cookie('pv_auth',token(user),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:30*86400000,path:'/'});}
function auth(req,res,next){try{const t=req.cookies.pv_auth;if(!t)return err(res,401,'Não autenticado.');req.userId=jwt.verify(t,JWT_SECRET).sub;next();}catch{return err(res,401,'Sessão expirada.');}}

async function createSchema(){
  if(!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY,name text NOT NULL,phone_digits varchar(4) NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS accounts(id uuid PRIMARY KEY,name text NOT NULL,invite_code varchar(12) NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS memberships(id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,account_id));
    CREATE TABLE IF NOT EXISTS records(id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,type varchar(3) NOT NULL CHECK(type IN ('dep','wit')),amount numeric(14,2) NOT NULL CHECK(amount>0),bank text NOT NULL,description text,proof_name text,proof_mime text,proof_data bytea,created_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
    CREATE INDEX IF NOT EXISTS records_account_created_idx ON records(account_id,created_at DESC);
  `);
  // Existing databases may have an old uniqueness constraint on phone_digits.
  await pool.query(`DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='users'::regclass AND contype='u' AND pg_get_constraintdef(oid) ILIKE '%phone_digits%' LOOP EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I',c.conname); END LOOP; END $$;`);
}
async function db(){
  if(!pool)return false;
  if(!schemaPromise) schemaPromise=createSchema().catch(e=>{schemaPromise=null;throw e});
  await schemaPromise; return true;
}

async function findUser(id){if(await db()){const r=await pool.query('SELECT id,name,phone_digits AS "phoneDigits",created_at AS "createdAt" FROM users WHERE id=$1',[id]);return r.rows[0]||null;}return memory.users.get(id)||null;}
async function findByDigits(d){if(await db()){const r=await pool.query('SELECT id,name,phone_digits AS "phoneDigits",created_at AS "createdAt" FROM users WHERE phone_digits=$1 ORDER BY created_at DESC LIMIT 1',[d]);return r.rows[0]||null;}return [...memory.users.values()].find(x=>x.phoneDigits===d)||null;}
async function accountFor(userId){if(await db()){const r=await pool.query('SELECT a.id,a.name,a.invite_code AS "inviteCode",a.created_at AS "createdAt" FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=$1 ORDER BY m.created_at LIMIT 1',[userId]);return r.rows[0]||null;}const m=[...memory.memberships.values()].find(x=>x.userId===userId);return m?memory.accounts.get(m.accountId):null;}
async function members(accountId){if(await db()){const r=await pool.query('SELECT u.id,u.name,u.created_at AS "createdAt" FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.account_id=$1 ORDER BY m.created_at',[accountId]);return r.rows.map(x=>({...x,userId:x.id,short:shortName(x.name),initial:initial(x.name)}));}return [...memory.memberships.values()].filter(m=>m.accountId===accountId).map(m=>{const u=memory.users.get(m.userId);return {...u,userId:u.id,short:shortName(u.name),initial:initial(u.name)}});}
async function records(accountId){if(await db()){const r=await pool.query('SELECT id,user_id AS "userId",type,amount::float AS amount,bank,description,proof_name AS "proofName",created_at AS "createdAt" FROM records WHERE account_id=$1 ORDER BY created_at DESC',[accountId]);return r.rows;}return [...memory.records.values()].filter(x=>x.accountId===accountId).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(({accountId,...r})=>r);}
function broadcast(accountId,msg){const set=clients.get(accountId);if(!set)return;const text=JSON.stringify(msg);for(const ws of set){if(ws.readyState===1)ws.send(text)}}

app.get('/api/health',async(req,res)=>{if(!USE_PG)return res.json({ok:true,db:'memory',persistent:false});try{await db();res.json({ok:true,db:'postgres',persistent:true});}catch(e){res.status(503).json({ok:false,db:'postgres',persistent:true,error:e.message});}});
app.get('/api/session',async(req,res)=>{try{const t=req.cookies.pv_auth;if(!t)return res.json({ok:true,authenticated:false});const p=jwt.verify(t,JWT_SECRET);const user=await findUser(p.sub);if(!user)return res.json({ok:true,authenticated:false});const account=await accountFor(user.id);if(!account)return res.json({ok:true,authenticated:false});res.json({ok:true,authenticated:true,user,account});}catch(e){console.error('SESSION',e.message);res.json({ok:true,authenticated:false});}});

app.post('/api/auth/signup',async(req,res)=>{
  const name=cleanName(req.body?.name); const digits=String(req.body?.phoneDigits??'').replace(/\D/g,'');
  if(name.split(/\s+/).filter(Boolean).length<2)return err(res,400,'Informe nome e sobrenome.');
  if(!/^\d{4}$/.test(digits))return err(res,400,'Digite os 4 últimos dígitos.');
  const id=uid(); const createdAt=new Date().toISOString();
  try{
    if(await db()){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const ur=await client.query('INSERT INTO users(id,name,phone_digits,created_at) VALUES($1,$2,$3,$4) RETURNING id,name,phone_digits AS "phoneDigits",created_at AS "createdAt"',[id,name,digits,createdAt]);
        const user=ur.rows[0]; let account=null;
        for(let n=0;n<10 && !account;n++){
          try{const ar=await client.query('INSERT INTO accounts(id,name,invite_code) VALUES($1,$2,$3) RETURNING id,name,invite_code AS "inviteCode",created_at AS "createdAt"',[uid(),`Conta de ${shortName(name)}`,code()]);account=ar.rows[0];}
          catch(e){if(e.code!=='23505')throw e;}
        }
        if(!account)throw new Error('Falha ao gerar a conta conjunta.');
        await client.query('INSERT INTO memberships(id,user_id,account_id) VALUES($1,$2,$3)',[uid(),user.id,account.id]);
        await client.query('COMMIT'); setAuth(res,user);
        return res.status(201).json({ok:true,user,profile:user,account});
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }
    // Development fallback only: never used when DATABASE_URL is configured.
    const user={id,name,phoneDigits:digits,createdAt,short:shortName(name),initial:initial(name)};
    const account={id:uid(),name:`Conta de ${shortName(name)}`,inviteCode:code(),createdAt};
    memory.users.set(id,user);memory.accounts.set(account.id,account);memory.memberships.set(uid(),{userId:id,accountId:account.id});setAuth(res,user);
    return res.status(201).json({ok:true,user,profile:user,account});
  }catch(e){
    console.error('SIGNUP ERROR:',e);
    if(e?.code==='23505')return err(res,409,'Esse perfil já está cadastrado. Use a opção de entrar.');
    return err(res,500,'Não foi possível criar o perfil no servidor.',process.env.NODE_ENV==='production'?'':e.message);
  }
});

app.post('/api/auth/login',async(req,res)=>{try{const digits=String(req.body?.phoneDigits??'').replace(/\D/g,'');if(!/^\d{4}$/.test(digits))return err(res,400,'Digite os 4 últimos dígitos.');const user=await findByDigits(digits);if(!user)return err(res,404,'Perfil não encontrado.');const account=await accountFor(user.id);if(!account)return err(res,409,'Perfil sem conta conjunta.');setAuth(res,user);res.json({ok:true,user,profile:user,account});}catch(e){console.error('LOGIN ERROR:',e);err(res,500,'Falha no login.',process.env.NODE_ENV==='production'?'':e.message);}});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('pv_auth',{path:'/'});res.json({ok:true});});

app.get('/api/bootstrap',auth,async(req,res)=>{try{const account=await accountFor(req.userId);if(!account)return err(res,404,'Conta conjunta não encontrada.');const user=await findUser(req.userId);res.json({ok:true,user,account,members:await members(account.id),records:await records(account.id)});}catch(e){console.error('BOOTSTRAP',e);err(res,500,'Não foi possível carregar a conta.');}});
app.get('/api/account',auth,async(req,res)=>{try{const account=await accountFor(req.userId);if(!account)return err(res,404,'Conta não encontrada.');res.json({ok:true,account,members:await members(account.id)});}catch(e){err(res,500,'Não foi possível carregar os membros.');}});
app.post('/api/account/join',auth,async(req,res)=>{try{const invite=String(req.body?.code||'').trim().toUpperCase();if(!invite)return err(res,400,'Digite o código da conta.');const account=await (async()=>{if(await db()){const r=await pool.query('SELECT id,name,invite_code AS "inviteCode",created_at AS "createdAt" FROM accounts WHERE invite_code=$1',[invite]);return r.rows[0]||null;}return [...memory.accounts.values()].find(a=>a.inviteCode===invite)||null;})();if(!account)return err(res,404,'Código da conta não encontrado.');if(await db())await pool.query('INSERT INTO memberships(id,user_id,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[uid(),req.userId,account.id]);else memory.memberships.set(uid(),{userId:req.userId,accountId:account.id});const ms=await members(account.id),rs=await records(account.id);broadcast(account.id,{type:'members',members:ms});res.json({ok:true,account,members:ms,records:rs});}catch(e){console.error('JOIN',e);err(res,500,'Não foi possível entrar na conta.');}});

app.post('/api/records',auth,upload.single('proof'),async(req,res)=>{try{const account=await accountFor(req.userId);if(!account)return err(res,404,'Conta não encontrada.');const type=req.body?.type,amount=Number(req.body?.amount),bank=String(req.body?.bank||'').trim(),description=String(req.body?.description||'').trim();if(!['dep','wit'].includes(type))return err(res,400,'Tipo de movimentação inválido.');if(!(amount>0))return err(res,400,'Valor inválido.');if(!bank)return err(res,400,'Banco/origem é obrigatório.');const id=uid(),createdAt=new Date().toISOString(),f=req.file;if(await db()){await pool.query('INSERT INTO records(id,account_id,user_id,type,amount,bank,description,proof_name,proof_mime,proof_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,account.id,req.userId,type,amount.toFixed(2),bank,description,f?.originalname||null,f?.mimetype||null,f?.buffer||null,createdAt]);}else{memory.records.set(id,{id,accountId:account.id,userId:req.userId,type,amount:Number(amount.toFixed(2)),bank,description,proofName:f?.originalname||'',createdAt});if(f)memory.proofs.set(id,{mime:f.mimetype,data:f.buffer,name:f.originalname});}const rs=await records(account.id),record=rs.find(x=>x.id===id);broadcast(account.id,{type:'records',records:rs});res.json({ok:true,record});}catch(e){console.error('RECORD',e);err(res,500,'Não foi possível salvar a movimentação.');}});
app.get('/api/records/:id/proof',auth,async(req,res)=>{try{const account=await accountFor(req.userId);if(!account)return res.sendStatus(404);if(await db()){const r=await pool.query('SELECT proof_name,proof_mime,proof_data FROM records WHERE id=$1 AND account_id=$2',[req.params.id,account.id]);if(!r.rowCount||!r.rows[0].proof_data)return res.sendStatus(404);res.setHeader('Content-Type',r.rows[0].proof_mime||'application/octet-stream');res.end(r.rows[0].proof_data);return;}const f=memory.proofs.get(req.params.id);if(!f)return res.sendStatus(404);res.setHeader('Content-Type',f.mime);res.end(f.data);}catch{res.sendStatus(500);}});

const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
wss.on('connection',async(ws,req)=>{try{const raw=req.headers.cookie||'';const cookies={};for(const part of raw.split(';')){const i=part.indexOf('=');if(i>0)cookies[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1));}const p=jwt.verify(cookies.pv_auth,JWT_SECRET);const account=await accountFor(p.sub);if(!account)return ws.close();if(!clients.has(account.id))clients.set(account.id,new Set());clients.get(account.id).add(ws);ws.send(JSON.stringify({type:'connected',accountId:account.id}));ws.on('close',()=>clients.get(account.id)?.delete(ws));}catch{try{ws.close()}catch{}}});

// SPA fallback after API routes.
app.get('/{*splat}',(req,res)=>res.sendFile(path.join(ROOT,'index.html')));

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Poolvault listening on 0.0.0.0:${PORT} | ${USE_PG?'PostgreSQL':'memory fallback'}`);
  if(pool)db().then(()=>console.log('PostgreSQL schema ready')).catch(e=>console.error('PostgreSQL startup check failed:',e.message));
});
