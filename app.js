(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const state = {
    user: null,
    account: null,
    members: [],
    records: [],
    totals: { dep: 0, wit: 0, balance: 0 },
    individualBalance: 0
  };
  let mode = 'dep';
  let extFilter = 'all';
  let sessionToken = localStorage.getItem('poolvault_session') || '';
  let socket = null;
  let reconnectTimer = null;

  const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const shortName = (n) => String(n || '').trim().split(/\s+/)[0] || 'usuário';
  const initial = (n) => shortName(n).charAt(0).toUpperCase() || 'P';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; };
  const nowLabel = (iso) => new Date(iso).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });

  function toast(message) {
    const t = $('#toast');
    if (!t) return;
    t.innerHTML = `<div class="toast-msg">${esc(message)}</div>`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.innerHTML = ''; }, 3000);
  }

  function showView(id) {
    $$('.view').forEach(v => v.classList.toggle('active', v.id === id));
  }

  function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (sessionToken) headers.set('X-Poolvault-Session', sessionToken);
    return fetch(url, { ...options, headers, credentials: 'same-origin' }).then(async (response) => {
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('Resposta inválida do servidor.'); }
      if (data.session) {
        sessionToken = data.session;
        localStorage.setItem('poolvault_session', sessionToken);
      }
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `Erro HTTP ${response.status}`);
      }
      return data;
    });
  }

  function digits(selector) {
    return $$(selector).map(i => i.value).join('').replace(/\D/g, '').slice(0, 4);
  }

  function setupDigits() {
    $$('.dg').forEach((input, index, arr) => {
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 1);
        if (input.value && arr[index + 1]) arr[index + 1].focus();
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !input.value && arr[index - 1]) arr[index - 1].focus();
      });
    });
  }

  async function createProfile(e) {
    e.preventDefault();
    const name = $('#inp-name').value.trim();
    const phoneDigits = digits('#view-signup .dg');
    if (name.split(/\s+/).length < 2) return toast('Informe nome e sobrenome.');
    if (!/^\d{4}$/.test(phoneDigits)) return toast('Digite os 4 últimos dígitos.');

    showView('view-creating');
    try {
      const data = await api('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phoneDigits })
      });

      if (!data.ok || !data.user || !data.account || !data.session) {
        throw new Error('O servidor não concluiu a criação do perfil.');
      }

      state.user = data.user;
      state.account = data.account;
      await new Promise(resolve => setTimeout(resolve, 900));
      showView('view-success');
    } catch (err) {
      console.error('[cadastro]', err);
      showView('view-signup');
      toast(err.message || 'Não foi possível criar o perfil.');
    }
  }

  async function login(e) {
    e.preventDefault();
    const phoneDigits = digits('#view-login .dg');
    if (!/^\d{4}$/.test(phoneDigits)) return toast('Digite os 4 últimos dígitos.');
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneDigits })
      });
      state.user = data.user;
      state.account = data.account;
      await startApp();
    } catch (err) {
      console.error('[login]', err);
      toast(err.message || 'Falha ao acessar o sistema.');
    }
  }

  async function startApp() {
    try {
      await loadState();
      showApp();
      connectWS();
    } catch (err) {
      console.error('[app]', err);
      toast(err.message || 'Não foi possível carregar a conta.');
      showView('view-login');
    }
  }

  async function loadState() {
    const data = await api('/api/state');
    if (!data.user || !data.account) throw new Error('Sessão sem conta conjunta válida.');
    state.user = data.user;
    state.account = data.account;
    state.members = Array.isArray(data.members) ? data.members : [];
    state.records = Array.isArray(data.records) ? data.records : [];
    state.totals = data.totals || state.totals;
    state.individualBalance = Number(data.individualBalance || 0);
    renderAll();
  }

  function showApp() {
    showView('view-app');
    $('#home-hi').textContent = `${greeting()}, ${shortName(state.user.name)}`;
    $('#today-label').textContent = new Date().toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long' });
    $('#profile-btn').textContent = initial(state.user.name);
    renderAll();
    goTab('home');
  }

  function getMyMember() {
    return state.members.find(m => Number(m.userId) === Number(state.user.id)) || null;
  }

  function recordHTML(r) {
    const owner = state.members.find(m => Number(m.userId) === Number(r.userId)) || { initial: initial(r.userName), short: shortName(r.userName) };
    const proof = r.hasReceipt ? `<a class="proof" href="/api/records/${encodeURIComponent(r.id)}/receipt" target="_blank" rel="noopener">Comprovante: visualizar</a>` : '';
    return `<div class="item">
      <div class="item-left"><div class="avatar">${esc(owner.initial)}</div><div style="min-width:0">
        <div class="item-title">${esc(r.description || (r.type === 'dep' ? 'Depósito' : 'Saque'))}</div>
        <div class="item-sub">${esc(owner.short)} · ${esc(nowLabel(r.createdAt))} · ${esc(r.bank || '')}</div>
        ${proof}
      </div></div>
      <div class="amount ${r.type}">${r.type === 'dep' ? '+' : '-'} ${money(r.amount)}</div>
    </div>`;
  }

  function renderHome() {
    $('#joint-balance').textContent = money(state.totals.balance);
    $('#stat-dep').textContent = money(state.totals.dep);
    $('#stat-wit').textContent = money(state.totals.wit);
    $('#balance-status').textContent = state.totals.balance >= 0 ? (state.totals.dep ? 'Saldo positivo' : 'Sem movimentações') : 'Saldo negativo';
    $('#recent-list').innerHTML = state.records.slice(0, 5).map(recordHTML).join('') || '<div class="empty">Nenhuma movimentação registrada.</div>';
  }

  function renderExtrato() {
    let rows = state.records;
    if (extFilter === 'me') rows = rows.filter(r => Number(r.userId) === Number(state.user.id));
    if (extFilter === 'dep' || extFilter === 'wit') rows = rows.filter(r => r.type === extFilter);
    $('#extract-list').innerHTML = rows.map(recordHTML).join('') || '<div class="empty">Nenhum registro encontrado.</div>';
  }

  function renderMembers() {
    $('#member-count').textContent = state.members.length;
    $('#members-list').innerHTML = state.members.map(m => `<div class="item"><div class="item-left"><div class="avatar">${esc(initial(m.name))}</div><div><div class="item-title">${esc(m.name)} ${Number(m.userId) === Number(state.user.id) ? '<span style="color:#967000">· você</span>' : ''}</div><div class="item-sub">Perfil ativo nesta conta conjunta</div></div></div></div>`).join('') || '<div class="empty">Nenhum membro.</div>';
  }

  function renderAll() {
    if (!state.user) return;
    renderHome();
    renderExtrato();
    renderMembers();
    $('#config-name').textContent = state.user.name;
  }

  async function saveRecord(e) {
    e.preventDefault();
    const amount = Number($('#record-amount').value);
    if (!(amount > 0)) return toast('Informe um valor válido.');
    const file = $('#record-proof').files[0];
    if (file && file.size > 5 * 1024 * 1024) return toast('Comprovante limitado a 5 MB.');
    const fd = new FormData();
    fd.append('type', mode);
    fd.append('amount', amount.toFixed(2));
    fd.append('bank', $('#record-bank').value);
    fd.append('description', $('#record-desc').value.trim());
    if (file) fd.append('receipt', file);
    try {
      await api('/api/records', { method: 'POST', body: fd });
      e.target.reset();
      await loadState();
      goTab('home');
      toast(mode === 'dep' ? 'Depósito salvo e sincronizado.' : 'Saque salvo e sincronizado.');
    } catch (err) { toast(err.message); }
  }

  function openModal() {
    const modal = $('#modal');
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    modal.innerHTML = `<div class="modal-card"><h3>Entrar em uma conta conjunta</h3><div class="member-add-row">
      <div class="proof">Peça ao responsável pela conta o código exibido no sistema dele.</div>
      <label class="form">Código da conta<input id="join-code" maxlength="12" placeholder="Ex.: A4B9C2D1" autocomplete="off"></label>
      <div class="modal-actions"><button class="btn btn-ghost" id="cancel-modal">Cancelar</button><button class="btn btn-amber" id="join-account">Entrar</button></div>
    </div></div>`;
    $('#cancel-modal').onclick = closeModal;
    $('#join-account').onclick = async () => {
      const code = $('#join-code').value.trim().toUpperCase();
      if (!code) return toast('Informe o código da conta.');
      try {
        const data = await api('/api/accounts/join', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ code }) });
        state.account = data.account;
        closeModal();
        await loadState();
        connectWS();
        toast('Você entrou na conta conjunta.');
      } catch (err) { toast(err.message); }
    };
  }

  function closeModal() { const m = $('#modal'); m.classList.remove('open'); m.setAttribute('aria-hidden','true'); m.innerHTML = ''; }

  function goTab(tab) {
    $$('.tab').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
    $$('.page').forEach(x => x.classList.toggle('on', x.id === `page-${tab}`));
  }

  async function exportData() {
    try {
      const data = await api('/api/state');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'poolvault-backup.json'; a.click();
      URL.revokeObjectURL(a.href); toast('Backup exportado.');
    } catch (err) { toast(err.message); }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method:'POST' }); } catch {}
    sessionToken = ''; localStorage.removeItem('poolvault_session'); state.user = null; state.account = null; state.records = [];
    if (socket) socket.close();
    showView('view-login');
  }

  function connectWS() {
    if (!sessionToken || !state.account) return;
    if (socket && socket.readyState < 2) socket.close();
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws?token=${encodeURIComponent(sessionToken)}`);
    socket.onmessage = async event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'record_created' || message.type === 'members_changed') await loadState();
      } catch (err) { console.error('[ws]', err); }
    };
    socket.onclose = () => {
      clearTimeout(reconnectTimer);
      if (state.user) reconnectTimer = setTimeout(connectWS, 3000);
    };
  }

  function wire() {
    setupDigits();
    $('#signup-form').addEventListener('submit', createProfile);
    $('#login-form').addEventListener('submit', login);
    $('#record-form').addEventListener('submit', saveRecord);
    $$('#goto-login').forEach(b => b.onclick = () => showView('view-login'));
    $$('#goto-signup').forEach(b => b.onclick = () => showView('view-signup'));
    $$('#success-access').forEach(b => b.onclick = startApp);
    $$('#profile-btn').forEach(b => b.onclick = () => goTab('config'));
    $$('#quick-register,[data-action="quick-register"]').forEach(b => b.onclick = () => goTab('new'));
    $$('#page-home [data-action="go-extrato"]').forEach(b => b.onclick = () => goTab('extrato'));
    $$('#page-membros [data-action="add-member"]').forEach(b => b.onclick = openModal);
    $$('#page-config [data-action="export"]').forEach(b => b.onclick = exportData);
    $$('#page-config [data-action="logout"]').forEach(b => b.onclick = logout);
    $$('#page-config [data-action="reset"]').forEach(b => b.onclick = () => toast('Os dados agora são mantidos com segurança no servidor.'));
    $$('[data-tab]').forEach(b => b.onclick = () => goTab(b.dataset.tab));
    $$('[data-mode]').forEach(b => b.onclick = () => { $$('[data-mode]').forEach(x => x.classList.remove('active')); b.classList.add('active'); mode = b.dataset.mode; });
    $$('[data-filter]').forEach(b => b.onclick = () => { $$('[data-filter]').forEach(x => x.classList.remove('active')); b.classList.add('active'); extFilter = b.dataset.filter; renderExtrato(); });
  }

  async function boot() {
    wire();
    const tick = () => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}); };
    tick(); setInterval(tick, 1000);
    setTimeout(async () => {
      try {
        const data = await api('/api/session');
        if (data.authenticated && data.user && data.account) {
          state.user = data.user; state.account = data.account; await startApp();
        } else showView('view-signup');
      } catch (err) { console.error('[session]', err); showView('view-signup'); }
    }, 1800);
  }

  window.addEventListener('error', e => console.error('[Poolvault]', e.error || e.message));
  boot();
})();
