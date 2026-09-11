(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { user:null, account:null, members:[], records:[], totals:{balance:0,deposits:0,withdrawals:0}, individualBalance:0, type:'deposit', filter:'all' };
  let sessionToken = localStorage.getItem('pv_session') || '';
  let ws = null;
  const money = n => Number(n||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const toast = msg => { const t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>t.classList.remove('show'),3200); };
  const show = id => document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===id));
  const api = async (url, opts={}) => {
    const headers = new Headers(opts.headers||{}); if(sessionToken) headers.set('X-Poolvault-Session',sessionToken);
    const r = await fetch(url,{...opts,headers});
    const text = await r.text(); let data={}; try{data=text?JSON.parse(text):{}}catch{throw new Error('Resposta inválida do servidor.');}
    if(data.session){sessionToken=data.session;localStorage.setItem('pv_session',sessionToken);}
    if(!r.ok || data.ok===false) throw new Error(data.error || `Erro HTTP ${r.status}`);
    return data;
  };
  const digits = selector => [...document.querySelectorAll(selector)].map(x=>x.value).join('').replace(/\D/g,'').slice(0,4);
  function digitUX(selector){ const inputs=[...document.querySelectorAll(selector)]; inputs.forEach((el,i)=>{el.addEventListener('input',()=>{el.value=el.value.replace(/\D/g,'').slice(-1);if(el.value&&inputs[i+1])inputs[i+1].focus();});el.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!el.value&&inputs[i-1])inputs[i-1].focus();});}); }
  async function signup(e){
    e.preventDefault(); const name=$('inp-name').value.trim(), phoneDigits=digits('.dg');
    if(name.length<3)return toast('Informe seu nome completo.'); if(phoneDigits.length!==4)return toast('Informe os 4 últimos dígitos.');
    show('view-creating');
    try{ const data=await api('/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,phoneDigits})});
      if(!data.user && !data.profile) throw new Error('O servidor não retornou o perfil criado.');
      state.user=data.user||data.profile; state.account=data.account||null;
      await new Promise(r=>setTimeout(r,900)); show('view-success');
      setTimeout(()=>startApp(),1000);
    }catch(err){ show('view-signup'); toast(err.message); }
  }
  async function login(e){
    e.preventDefault(); const name=$('login-name').value.trim(), phoneDigits=digits('.ldg');
    if(!name||phoneDigits.length!==4)return toast('Informe nome e os 4 últimos dígitos.');
    try{const data=await api('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,phoneDigits})});state.user=data.user;state.account=data.account;await startApp();}catch(err){toast(err.message);}
  }
  async function startApp(){ try{await loadState();showApp();connectWS();}catch(err){toast(err.message);show('view-login');} }
  async function loadState(){const d=await api('/api/state');state.user=d.user;state.account=d.account;state.members=d.members||[];state.records=d.records||[];state.totals=d.totals||state.totals;state.individualBalance=Number(d.individualBalance||0);render();}
  function render(){
    if(!state.user)return;
    $('home-hi').textContent=`Olá, ${state.user.name.split(' ')[0]}`;$('home-date').textContent=new Date().toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long'});
    $('joint-balance').textContent=money(state.totals.balance);$('my-balance').textContent=money(state.individualBalance);$('month-deposits').textContent=money(state.totals.deposits);$('week-total').textContent=money(state.totals.balance);
    $('account-code').textContent=state.account?.code||'—';$('config-name').textContent=state.user.name;$('config-phone').textContent=`•••• ${state.user.phoneDigits}`;
    $('member-avatars').innerHTML=state.members.slice(0,4).map(m=>`<div class="avatar">${m.name.charAt(0).toUpperCase()}</div>`).join('');
    renderRecords(); renderMembers();
  }
  const recordHtml=r=>`<div class="record"><div class="record-icon">${r.type==='deposit'?'↓':'↑'}</div><div class="record-main"><strong>${r.type==='deposit'?'Depósito':'Saque'} · ${r.userName||'Usuário'}</strong><small>${new Date(r.createdAt).toLocaleDateString('pt-BR')} · ${r.bank||'Sem origem'}${r.hasReceipt?' · 📎 comprovante':''}${r.description?' · '+r.description:''}</small></div><div class="record-amount ${r.type==='deposit'?'dep':'wit'}">${r.type==='deposit'?'+':'-'} ${money(r.amount)}</div></div>`;
  function renderRecords(){const arr=state.filter==='all'?state.records:state.filter==='me'?state.records.filter(r=>Number(r.userId)===Number(state.user.id)):state.records.filter(r=>r.type===state.filter);$('home-records').innerHTML=state.records.slice(0,5).map(recordHtml).join('')||'<div class="record"><div class="record-main"><strong>Nenhum registro ainda</strong><small>Seu primeiro movimento aparecerá aqui.</small></div></div>';$('extract-records').innerHTML=arr.map(recordHtml).join('')||'<div class="record"><div class="record-main"><strong>Nenhum registro encontrado</strong></div></div>';}
  function renderMembers(){$('members-list').innerHTML=state.members.map(m=>`<div class="member"><div class="avatar">${m.name.charAt(0).toUpperCase()}</div><div class="member-info"><strong>${m.name}${Number(m.id)===Number(state.user.id)?' (você)':''}</strong><small>•••• ${m.phoneDigits}</small></div></div>`).join('')||'<p>Nenhum membro.</p>';}
  function goTab(tab){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active-page',p.id===`page-${tab}`));document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));if(tab==='new')document.querySelector('.tabbar').scrollIntoView({block:'end'});}
  async function createRecord(e){e.preventDefault();const amount=Number($('record-amount').value);if(!amount||amount<=0)return toast('Informe um valor válido.');const fd=new FormData();fd.append('type',state.type);fd.append('amount',amount);fd.append('bank',$('record-bank').value);fd.append('description',$('record-description').value);const f=$('record-receipt').files[0];if(f)fd.append('receipt',f);try{await api('/api/records',{method:'POST',body:fd});e.target.reset();goTab('home');await loadState();toast('Registro salvo e sincronizado.');}catch(err){toast(err.message);}}
  async function join(e){e.preventDefault();const code=$('join-code').value.trim();if(!code)return toast('Informe o código.');try{await api('/api/accounts/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});$('join-code').value='';await loadState();connectWS();toast('Você entrou na conta conjunta.');}catch(err){toast(err.message);}}
  function connectWS(){if(!sessionToken)return;if(ws&&ws.readyState<2)ws.close();const proto=location.protocol==='https:'?'wss':'ws';ws=new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(sessionToken)}`);ws.onmessage=async e=>{try{const m=JSON.parse(e.data);if(['record_created','members_changed'].includes(m.type))await loadState();}catch{}};ws.onclose=()=>setTimeout(()=>{if(state.user)connectWS()},3000);}
  async function boot(){
    digitUX('.dg');digitUX('.ldg');
    $('signup-form').addEventListener('submit',signup);$('login-form').addEventListener('submit',login);$('goto-login').onclick=()=>show('view-login');$('goto-signup').onclick=()=>show('view-signup');$('success-access').onclick=startApp;$('quick-register').onclick=()=>goTab('new');$('see-extract').onclick=()=>goTab('extrato');$('record-form').addEventListener('submit',createRecord);$('join-form').addEventListener('submit',join);
    document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{state.type=b.dataset.type;document.querySelectorAll('.seg button').forEach(x=>x.classList.toggle('seg-on',x===b));});
    document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;document.querySelectorAll('.filters button').forEach(x=>x.classList.toggle('filter-on',x===b));renderRecords();});
    document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>goTab(b.dataset.tab));$('copy-code').onclick=async()=>{try{await navigator.clipboard.writeText(state.account.code);toast('Código copiado.')}catch{toast(state.account.code)}};$('logout').onclick=async()=>{try{await api('/api/auth/logout',{method:'POST'})}catch{}localStorage.removeItem('pv_session');sessionToken='';if(ws)ws.close();state.user=null;show('view-login');};
    // Splash is deliberately independent of the backend: it always advances.
    setTimeout(async()=>{try{const d=await api('/api/session');if(d.authenticated){state.user=d.user;state.account=d.account;await startApp();}else show('view-signup');}catch{show('view-signup');}},1600);
  }
  window.addEventListener('error',e=>console.error('[Poolvault]',e.error||e.message));
  boot();
})();
