import express from 'express';
import http from 'http';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import pg from 'pg';
import { WebSocketServer } from 'ws';

const { Pool } = pg;
const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'poolvault-dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || '';
const usePg = Boolean(DATABASE_URL);
const pool = usePg ? new Pool({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized:false } : false, max: 10 }) : null;
let dbReady = null;
let dbInitError = null;
const memory = { users:new Map(), accounts:new Map(), memberships:new Map(), records:new Map(), proofs:new Map() };
const clients = new Map();
const upload = multer({ storage:multer.memoryStorage(), limits:{fileSize:3*1024*1024} });

app.use(express.json({limit:'200kb'}));
app.use(cookieParser());
// Os arquivos do frontend ficam na raiz do projeto para facilitar o deploy no Render.
const ROOT = process.cwd();
app.get('/', (req,res)=>res.sendFile(ROOT+'/index.html'));
app.get('/index.html', (req,res)=>res.sendFile(ROOT+'/index.html'));
app.get('/styles.css', (req,res)=>res.sendFile(ROOT+'/styles.css'));
app.get('/app.js', (req,res)=>res.sendFile(ROOT+'/app.js'));
app.get('/manifest.webmanifest', (req,res)=>res.sendFile(ROOT+'/manifest.webmanifest'));


const uid=()=>crypto.randomUUID();
const accountCode=()=>crypto.randomBytes(4).toString('hex').toUpperCase();
const cleanName=s=>String(s||'').trim().replace(/\s+/g,' ');
const shortName=n=>cleanName(n).split(' ')[0] || 'usuário';
const initial=n=>shortName(n).charAt(0).toUpperCase() || 'P';
const sendError=(res,status,msg)=>res.status(status).json({ok:false,error:msg});
function tokenFor(user){ return jwt.sign({sub:user.id},JWT_SECRET,{expiresIn:'30d'}); }
function setAuth(res,user){res.cookie('pv_auth',tokenFor(user),{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:30*24*3600*1000});}
function auth(req,res,next){try{const t=req.cookies.pv_auth;if(!t)return sendError(res,401,'Não autenticado.');req.userId=jwt.verify(t,JWT_SECRET).sub;next()}catch{return sendError(res,401,'Sessão expirada.')}}

async function initDb(){
 if(!usePg) return true;
 await pool.query(`
  CREATE TABLE IF NOT EXISTS users(
    id uuid PRIMARY KEY,
    name text NOT NULL,
    phone_digits varchar(4) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS accounts(
    id uuid PRIMARY KEY,
    name text NOT NULL,
    invite_code varchar(12) NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS memberships(
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(user_id,account_id)
  );
  CREATE TABLE IF NOT EXISTS records(
    id uuid PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type varchar(3) NOT NULL CHECK(type IN ('dep','wit')),
    amount numeric(14,2) NOT NULL CHECK(amount>0),
    bank text NOT NULL,
    description text,
    proof_name text,
    proof_mime text,
    proof_data bytea,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS records_account_created_idx ON records(account_id,created_at DESC);
  CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
 `);
 // Migration for databases created by earlier Poolvault builds.
 await pool.query(`ALTER TABLE users ALTER COLUMN phone_digits TYPE varchar(4) USING phone_digits::text`);
 // The 4-digit value is an access hint, not a globally unique identifier.
 await pool.query(`
   DO $$ DECLARE c record; BEGIN
     FOR c IN
       SELECT conname FROM pg_constraint
       WHERE conrelid='users'::regclass AND contype='u'
         AND pg_get_constraintdef(oid) ILIKE '%phone_digits%'
     LOOP
       EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
     END LOOP;
   END $$;
 `);
 return true;
}
async function ensureDb(){
 if(!usePg) return;
 if(dbReady) return dbReady;
 dbReady=(async()=>{try{await initDb();dbInitError=null;console.log('Banco de dados pronto.');}catch(e){dbInitError=e;console.error('Banco de dados indisponível:',e.message);throw e;}})();
 return dbReady;
}

async function findUserById(id){ if(usePg){await ensureDb();const r=await pool.query('SELECT id,name,phone_digits as "phoneDigits",created_at as "createdAt" FROM users WHERE id=$1',[id]);return r.rows[0]||null;} return memory.users.get(id)||null; }
async function findUserByDigits(d){ if(usePg){await ensureDb();const r=await pool.query('SELECT id,name,phone_digits as "phoneDigits",created_at as "createdAt" FROM users WHERE phone_digits=$1',[d]);return r.rows[0]||null;} return [...memory.users.values()].find(u=>u.phoneDigits===d)||null; }
async function createUser(user){ if(usePg){await ensureDb();const r=await pool.query('INSERT INTO users(id,name,phone_digits) VALUES($1,$2,$3) RETURNING id,name,phone_digits as "phoneDigits",created_at as "createdAt"',[user.id,user.name,user.phoneDigits]);return r.rows[0];} memory.users.set(user.id,user);return user; }
async function findAccountByCode(code){ if(usePg){await ensureDb();const r=await pool.query('SELECT id,name,invite_code as "inviteCode" FROM accounts WHERE invite_code=$1',[code.toUpperCase()]);return r.rows[0]||null;} return [...memory.accounts.values()].find(a=>a.inviteCode===code.toUpperCase())||null; }
async function accountForUser(userId){ if(usePg){await ensureDb();const r=await pool.query('SELECT a.id,a.name,a.invite_code as "inviteCode" FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE m.user_id=$1 ORDER BY a.created_at LIMIT 1',[userId]);return r.rows[0]||null;} const m=[...memory.memberships.values()].find(x=>x.userId===userId);return m?memory.accounts.get(m.accountId):null; }
async function createAccountFor(user,name){let code=accountCode();if(usePg){await ensureDb();for(let i=0;i<5;i++){try{const r=await pool.query('INSERT INTO accounts(id,name,invite_code) VALUES($1,$2,$3) RETURNING id,name,invite_code as "inviteCode"',[uid(),`Conta de ${shortName(name)}`,code]);const a=r.rows[0];await pool.query('INSERT INTO memberships(id,user_id,account_id) VALUES($1,$2,$3)',[uid(),user.id,a.id]);return a}catch(e){code=accountCode()}}throw new Error('Não foi possível criar a conta.')}const a={id:uid(),name:`Conta de ${shortName(name)}`,inviteCode:code};memory.accounts.set(a.id,a);memory.memberships.set(uid(),{userId:user.id,accountId:a.id});return a;}
async function joinAccount(user,account){if(usePg){await ensureDb();await pool.query('INSERT INTO memberships(id,user_id,account_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[uid(),user.id,account.id]);}else{memory.memberships.set(uid(),{userId:user.id,accountId:account.id});}return account;}
async function memberRows(accountId){if(usePg){await ensureDb();const r=await pool.query('SELECT u.id,u.name,u.id as "userId",u.created_at as "createdAt" FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.account_id=$1 ORDER BY m.created_at',[accountId]);return r.rows.map(x=>({...x,short:shortName(x.name),initial:initial(x.name)}));}return [...memory.memberships.values()].filter(m=>m.accountId===accountId).map(m=>{const u=memory.users.get(m.userId);return {...u,userId:u.id,short:shortName(u.name),initial:initial(u.name)}});}
async function recordRows(accountId){if(usePg){await ensureDb();const r=await pool.query('SELECT id,"user_id" as "userId",type,amount::float as amount,bank,description,proof_name as "proofName",created_at as "createdAt" FROM records WHERE account_id=$1 ORDER BY created_at DESC',[accountId]);return r.rows;}return [...memory.records.values()].filter(r=>r.accountId===accountId).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(({accountId,...r})=>r);}
async function membership(accountId,userId){if(usePg){await ensureDb();const r=await pool.query('SELECT 1 FROM memberships WHERE account_id=$1 AND user_id=$2',[accountId,userId]);return r.rowCount>0;}return [...memory.memberships.values()].some(m=>m.accountId===accountId&&m.userId===userId);}
function broadcast(accountId,message){const set=clients.get(accountId);if(!set)return;const data=JSON.stringify(message);for(const ws of set){if(ws.readyState===1)ws.send(data)}}

app.get('/api/health',async(req,res)=>{if(usePg){try{await ensureDb();return res.json({ok:true,db:'postgres',ready:true,time:new Date().toISOString()});}catch(e){return res.status(503).json({ok:false,db:'postgres',ready:false,error:e.message,time:new Date().toISOString()});}}res.json({ok:true,db:'memory',ready:true,time:new Date().toISOString()});});
app.get('/api/session',async(req,res)=>{try{const t=req.cookies.pv_auth;if(!t)return res.json({ok:true,authenticated:false});const p=jwt.verify(t,JWT_SECRET);const user=await findUserById(p.sub);if(!user)return res.json({ok:true,authenticated:false});const account=await accountForUser(user.id);return res.json({ok:true,authenticated:true,user,account});}catch{return res.json({ok:true,authenticated:false})}});

app.post('/api/auth/signup',async(req,res)=>{
  try{
    await ensureDb();
    const name=cleanName(req.body?.name);
    const digits=String(req.body?.phoneDigits||'').replace(/\D/g,'');
    if(name.split(/\s+/).filter(Boolean).length<2)return sendError(res,400,'Informe nome e sobrenome.');
    if(!/^\d{4}$/.test(digits))return sendError(res,400,'Digite os 4 últimos dígitos.');

    // Every profile is independent. The first profile creates a new shared account.
    // A later user joins an existing account from the Membros area using its invite code.
    const userData={id:uid(),name,short:shortName(name),initial:initial(name),phoneDigits:digits,createdAt:new Date().toISOString()};
    if(usePg){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const ur=await client.query('INSERT INTO users(id,name,phone_digits,created_at) VALUES($1,$2,$3,$4) RETURNING id,name,phone_digits as "phoneDigits",created_at as "createdAt"',[userData.id,name,digits,userData.createdAt]);
        const user=ur.rows[0];
        let account=null;
        for(let i=0;i<10;i++){
          try{
            const code=accountCode();
            const ar=await client.query('INSERT INTO accounts(id,name,invite_code) VALUES($1,$2,$3) RETURNING id,name,invite_code as "inviteCode",created_at as "createdAt"',[uid(),`Conta de ${shortName(name)}`,code]);
            account=ar.rows[0];
            break;
          }catch(e){if(e.code!=='23505')throw e;}
        }
        if(!account)throw new Error('Não foi possível gerar o código da conta.');
        await client.query('INSERT INTO memberships(id,user_id,account_id) VALUES($1,$2,$3)',[uid(),user.id,account.id]);
        await client.query('COMMIT');
        setAuth(res,user);
        return res.status(201).json({ok:true,user,account});
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }
    const user=await createUser(userData);
    const account=await createAccountFor(user,name);
    setAuth(res,user);
    return res.status(201).json({ok:true,user,account});
  }catch(e){
    console.error('SIGNUP ERROR:',e);
    if(e?.code==='23505')return sendError(res,409,'Esse perfil já está cadastrado. Tente entrar com os 4 últimos dígitos.');
    return sendError(res,500,`Não foi possível criar o perfil. ${e?.message||''}`.trim());
  }
});
app.post('/api/auth/login',async(req,res)=>{
  try{
    await ensureDb();
    const digits=String(req.body?.phoneDigits||'').replace(/\D/g,'');
    if(!/^\d{4}$/.test(digits))return sendError(res,400,'Digite os 4 últimos dígitos.');
    const user=await findUserByDigits(digits);
    if(!user)return sendError(res,404,'Perfil não encontrado.');
    const account=await accountForUser(user.id);
    if(!account)return sendError(res,409,'Seu perfil existe, mas ainda não está vinculado a uma conta conjunta.');
    setAuth(res,user);
    return res.json({ok:true,user,account});
  }catch(e){console.error('LOGIN ERROR:',e);return sendError(res,500,'Falha no login.');}
});
app.post('/api/auth/logout',(req,res)=>{res.clearCookie('pv_auth');res.json({ok:true})});

app.get('/api/bootstrap',auth,async(req,res)=>{try{const account=await accountForUser(req.userId);if(!account)return sendError(res,404,'Usuário sem conta conjunta.');if(!(await membership(account.id,req.userId)))return sendError(res,403,'Sem acesso à conta.');res.json({ok:true,user:await findUserById(req.userId),account,members:await memberRows(account.id),records:await recordRows(account.id)});}catch(e){console.error(e);sendError(res,500,'Falha ao carregar a conta.')}});

app.post('/api/account/join',auth,async(req,res)=>{try{const code=String(req.body.code||'').trim().toUpperCase();const account=await findAccountByCode(code);if(!account)return sendError(res,404,'Código não encontrado.');await joinAccount({id:req.userId},account);const data={ok:true,account,members:await memberRows(account.id),records:await recordRows(account.id)};res.json(data);broadcast(account.id,{type:'members',members:data.members});}catch(e){sendError(res,500,'Não foi possível entrar na conta.')}});
app.get('/api/account',auth,async(req,res)=>{const a=await accountForUser(req.userId);if(!a)return sendError(res,404,'Conta não encontrada.');res.json({ok:true,account:a,members:await memberRows(a.id)});});

app.post('/api/records',auth,upload.single('proof'),async(req,res)=>{try{const account=await accountForUser(req.userId);if(!account)return sendError(res,404,'Conta não encontrada.');const type=req.body.type, amount=Number(req.body.amount), bank=String(req.body.bank||'').trim(), description=String(req.body.description||'').trim();if(!['dep','wit'].includes(type))return sendError(res,400,'Tipo inválido.');if(!(amount>0))return sendError(res,400,'Valor inválido.');if(!bank)return sendError(res,400,'Banco/origem é obrigatório.');const id=uid(), createdAt=new Date().toISOString(), proof=req.file||null;if(usePg){await pool.query('INSERT INTO records(id,account_id,user_id,type,amount,bank,description,proof_name,proof_mime,proof_data,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,account.id,req.userId,type,amount.toFixed(2),bank,description,proof?.originalname||null,proof?.mimetype||null,proof?.buffer||null,createdAt]);}else{memory.records.set(id,{id,accountId:account.id,userId:req.userId,type,amount:Number(amount.toFixed(2)),bank,description,proofName:proof?.originalname||'',createdAt});if(proof)memory.proofs.set(id,{mime:proof.mimetype,data:proof.buffer,name:proof.originalname});}
const records=await recordRows(account.id);const created=records.find(r=>r.id===id);res.json({ok:true,record:created});broadcast(account.id,{type:'records',records});}catch(e){console.error(e);sendError(res,500,'Não foi possível salvar a movimentação.')}});

app.get('/api/records/:id/proof',auth,async(req,res)=>{try{const account=await accountForUser(req.userId);if(!account)return res.sendStatus(404);if(usePg){const r=await pool.query('SELECT proof_name,proof_mime,proof_data FROM records WHERE id=$1 AND account_id=$2',[req.params.id,account.id]);if(!r.rowCount||!r.rows[0].proof_data)return res.sendStatus(404);res.setHeader('Content-Type',r.rows[0].proof_mime||'application/octet-stream');res.setHeader('Content-Disposition',`inline; filename="${String(r.rows[0].proof_name||'comprovante').replace(/"/g,'')}"`);return res.end(r.rows[0].proof_data);}const r=memory.proofs.get(req.params.id);if(!r)return res.sendStatus(404);res.setHeader('Content-Type',r.mime);res.end(r.data);}catch{res.sendStatus(500)}});

const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(request,socket,head)=>{if(request.url!=='/ws'){socket.destroy();return;}wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws,request));});
wss.on('connection',async(ws,req)=>{try{const cookies=Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i).trim(),decodeURIComponent(x.slice(i+1))]}));const p=jwt.verify(cookies.pv_auth,JWT_SECRET);const account=await accountForUser(p.sub);if(!account){ws.close();return;}if(!clients.has(account.id))clients.set(account.id,new Set());clients.get(account.id).add(ws);ws.send(JSON.stringify({type:'connected',accountId:account.id}));ws.on('close',()=>clients.get(account.id)?.delete(ws));}catch{ws.close();}});

app.get('/{*splat}',(req,res)=>res.sendFile(ROOT+'/index.html'));

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Poolvault rodando em http://0.0.0.0:${PORT} | DB: ${usePg?'PostgreSQL':'memória'}`);
  if(usePg) ensureDb().catch(()=>{});
});
