'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=Number(process.env.PORT||10000), ROOT=__dirname, DATA_DIR=process.env.POOLVAULT_DATA_DIR||path.join(ROOT,'data'), FILE=path.join(DATA_DIR,'poolvault.json');
const SECRET=process.env.SESSION_SECRET||'poolvault-dev-secret';
const db={users:[],accounts:[],memberships:[],records:[],seq:{users:1,accounts:1,memberships:1,records:1}};
let saving=Promise.resolve(); fs.mkdirSync(DATA_DIR,{recursive:true});
try{if(fs.existsSync(FILE))Object.assign(db,JSON.parse(fs.readFileSync(FILE,'utf8')));}catch(e){console.error(e.message)}
const save=()=>{saving=saving.then(()=>{const t=FILE+'.tmp';fs.writeFileSync(t,JSON.stringify(db));fs.renameSync(t,FILE)});return saving};
const json=(res,status,o,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(o))};
const body=req=>new Promise((ok,no)=>{let a=[];let n=0;req.on('data',c=>{n+=c.length;if(n>8e6){no(Error('Payload muito grande'));req.destroy()}else a.push(c)});req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(a).toString()||'{}'))}catch(e){no(Error('JSON inválido'))}});req.on('error',no)});
const clean=v=>String(v||'').trim().replace(/\s+/g,' '), d4=v=>String(v||'').replace(/\D/g,'').slice(-4), code=()=>crypto.randomBytes(5).toString('hex').toUpperCase();
function token(uid){const p=uid+'.'+Date.now();const s=crypto.createHmac('sha256',SECRET).update(p).digest('hex');return Buffer.from(p+'.'+s).toString('base64url')}
function uid(req){const h=String(req.headers['x-poolvault-session']||'');try{const x=Buffer.from(h,'base64url').toString(),p=x.split('.');if(p.length!==3)return null;const ex=crypto.createHmac('sha256',SECRET).update(p[0]+'.'+p[1]).digest('hex');return ex===p[2]?Number(p[0]):null}catch{return null}}
const user=id=>db.users.find(u=>Number(u.id)===Number(id))||null;
const account=id=>{const m=db.memberships.find(x=>Number(x.userId)===Number(id));return m?db.accounts.find(a=>Number(a.id)===Number(m.accountId))||null:null};
function payload(id){const u=user(id),a=account(id);return {ok:true,version:'11.0.0',user:u&&{id:Number(u.id),name:u.name,phoneDigits:u.phoneDigits,createdAt:u.createdAt},profile:u&&{id:Number(u.id),name:u.name,phoneDigits:u.phoneDigits,createdAt:u.createdAt},account:a&&{id:Number(a.id),name:a.name,code:a.code}}}
async function api(req,res){const u=new URL(req.url,'http://localhost'),p=u.pathname;res.setHeader('X-Poolvault-Version','11.0.0');
try{
 if(req.method==='GET'&&p==='/api/health')return json(res,200,{ok:true,server:true,version:'11.0.0',storage:'json-file',users:db.users.length,accounts:db.accounts.length});
 if(req.method==='GET'&&p==='/api/session'){const id=uid(req);if(!id||!user(id)||!account(id))return json(res,200,{ok:true,authenticated:false,version:'11.0.0'});return json(res,200,{...payload(id),authenticated:true,session:null});}
 if(req.method==='POST'&&p==='/api/auth/signup'){
   const b=await body(req),name=clean(b.name),ph=d4(b.phoneDigits);if(name.split(' ').length<2)return json(res,400,{ok:false,error:'Informe nome e sobrenome.'});if(!/^\d{4}$/.test(ph))return json(res,400,{ok:false,error:'Informe os 4 últimos dígitos do celular.'});
   const now=new Date().toISOString(),u={id:db.seq.users++,name,phoneDigits:ph,createdAt:now},a={id:db.seq.accounts++,name:'Conta de '+name.split(' ')[0],code:code(),createdBy:u.id,createdAt:now};
   db.users.push(u);db.accounts.push(a);db.memberships.push({id:db.seq.memberships++,accountId:a.id,userId:u.id,joinedAt:now});await save();const s=token(u.id);res.setHeader('X-Poolvault-Session',s);return json(res,201,{...payload(u.id),session:s});
 }
 if(req.method==='POST'&&p==='/api/auth/login'){
   const b=await body(req),ph=d4(b.phoneDigits),x=[...db.users].reverse().find(x=>x.phoneDigits===ph);if(!x)return json(res,401,{ok:false,error:'Perfil não encontrado. Cadastre-se primeiro.'});const a=account(x.id);if(!a)return json(res,409,{ok:false,error:'Seu perfil não possui uma conta conjunta.'});const s=token(x.id);return json(res,200,{...payload(x.id),session:s});
 }
 if(req.method==='POST'&&p==='/api/auth/logout')return json(res,200,{ok:true});
 const id=uid(req);if(!id||!user(id))return json(res,401,{ok:false,error:'Sessão não encontrada. Faça login novamente.'});
 if(req.method==='GET'&&p==='/api/state'){
   const a=account(id),ms=db.memberships.filter(m=>Number(m.accountId)===Number(a.id)).map(m=>{const x=user(m.userId);return {id:x.id,userId:x.id,name:x.name,phoneDigits:x.phoneDigits,createdAt:x.createdAt,membershipId:m.id,joinedAt:m.joinedAt}}),rs=db.records.filter(r=>Number(r.accountId)===Number(a.id)).sort((x,y)=>new Date(y.createdAt)-new Date(x.createdAt)).slice(0,200).map(r=>({id:r.id,type:r.type,amount:Number(r.amount),bank:r.bank||'',description:r.description||'',createdAt:r.createdAt,userId:r.userId,userName:user(r.userId)?.name||'Usuário',hasReceipt:Boolean(r.receipt)}));
   const dep=rs.filter(r=>r.type==='dep').reduce((s,r)=>s+r.amount,0),wit=rs.filter(r=>r.type==='wit').reduce((s,r)=>s+r.amount,0),ind=rs.filter(r=>r.userId===id).reduce((s,r)=>s+(r.type==='dep'?r.amount:-r.amount),0);return json(res,200,{ok:true,user:user(id),account:a,members:ms,records:rs,totals:{dep,wit,balance:dep-wit},individualBalance:ind,version:'11.0.0'});
 }
 if(req.method==='POST'&&p==='/api/accounts/join'){const b=await body(req),a=db.accounts.find(x=>x.code===String(b.code||'').trim().toUpperCase());if(!a)return json(res,404,{ok:false,error:'Conta não encontrada.'});if(!db.memberships.some(m=>m.accountId===a.id&&m.userId===id))db.memberships.push({id:db.seq.memberships++,accountId:a.id,userId:id,joinedAt:new Date().toISOString()});await save();return json(res,200,{ok:true,account:a});}
 if(req.method==='POST'&&p==='/api/records'){
   const b=await body(req),a=account(id),v=Math.round(Number(b.amount)*100)/100;if(!(v>0))return json(res,400,{ok:false,error:'Informe um valor válido.'});const r={id:db.seq.records++,accountId:a.id,userId:id,type:b.type==='wit'?'wit':'dep',amount:v,bank:clean(b.bank),description:clean(b.description),receipt:b.receipt?.data||null,receiptName:b.receipt?.name||null,receiptType:b.receipt?.type||null,createdAt:new Date().toISOString()};db.records.push(r);await save();return json(res,201,{ok:true,record:{id:r.id,type:r.type,amount:r.amount,bank:r.bank,description:r.description,createdAt:r.createdAt,userId:id,userName:user(id).name,hasReceipt:Boolean(r.receipt)}});
 }
 const m=p.match(/^\/api\/records\/(\d+)\/receipt$/);if(req.method==='GET'&&m){const a=account(id),r=db.records.find(x=>Number(x.id)===Number(m[1])&&Number(x.accountId)===Number(a.id));if(!r||!r.receipt)return res.writeHead(404).end();let b=r.receipt,t=r.receiptType||'application/octet-stream';if(b.startsWith('data:')){const z=b.match(/^data:([^;]+);base64,(.*)$/s);if(z){t=z[1];b=Buffer.from(z[2],'base64')}}else b=Buffer.from(b,'base64');res.writeHead(200,{'Content-Type':t,'Content-Disposition':'inline; filename="'+String(r.receiptName||'comprovante').replace(/"/g,'')+'"'});return res.end(b)}
 return json(res,404,{ok:false,error:'Rota da API não encontrada.'});
}catch(e){console.error('[api]',e);return json(res,500,{ok:false,error:e.message||'Erro interno',version:'11.0.0'})}}
function staticFile(req,res){let p=new URL(req.url,'http://localhost').pathname;if(p==='/')p='/index.html';const f=path.join(ROOT,path.normalize(p));if(!f.startsWith(ROOT)||!fs.existsSync(f)||!fs.statSync(f).isFile())return json(res,404,{ok:false,error:'Arquivo não encontrado'});const ext=path.extname(f),mime={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});fs.createReadStream(f).pipe(res)}
http.createServer((req,res)=>req.url.startsWith('/api/')?api(req,res):req.method==='GET'?staticFile(req,res):json(res,405,{ok:false,error:'Método não permitido'})).listen(PORT,'0.0.0.0',()=>console.log(`Poolvault 11.0.0 ativo na porta ${PORT}`));
