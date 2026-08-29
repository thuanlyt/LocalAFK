const state = {
  guildId: null,
  textChannelId: null,
  voiceChannelId: null,
};

const el = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('unauthenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function showLogin() {
  el('login-view').hidden = false;
  el('dashboard-view').hidden = true;
}

function showDashboard() {
  el('login-view').hidden = true;
  el('dashboard-view').hidden = false;
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- Login ----

async function initLogin() {
  const cfg = await fetch('/auth/config').then((r) => r.json());
  if (cfg.oauthEnabled) el('btn-oauth').hidden = false;
  if (cfg.passwordEnabled) el('form-password').hidden = false;
  if (!cfg.oauthEnabled && !cfg.passwordEnabled) el('login-none').hidden = false;

  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    el('login-error').hidden = false;
    el('login-error').textContent = 'Đăng nhập thất bại. Vui lòng thử lại.';
  }

  el('btn-oauth').addEventListener('click', () => {
    location.href = '/auth/login';
  });

  el('form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = el('input-password').value;
    const res = await fetch('/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      location.href = '/';
    } else {
      el('login-error').hidden = false;
      el('login-error').textContent = 'Sai mật khẩu.';
    }
  });
}

// ---- Dashboard bootstrap ----

async function initDashboard() {
  const me = await api('/api/me');
  el('bot-name').textContent = me.bot?.username || 'Bot chưa online';
  if (me.bot?.avatar) el('bot-avatar').src = me.bot.avatar;
  showDashboard();

  el('btn-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.href = '/';
  });

  el('form-send').addEventListener('submit', onSendMessage);
  el('btn-voice-leave').addEventListener('click', onVoiceLeave);

  await loadGuilds();
  await refreshVoiceStatus();
  connectSocket();
}

// ---- Guilds / Channels ----

async function loadGuilds() {
  const guilds = await api('/api/guilds');
  const list = el('guild-list');
  list.innerHTML = '';
  for (const g of guilds) {
    const li = document.createElement('li');
    li.textContent = g.name;
    li.title = g.name;
    li.dataset.id = g.id;
    li.addEventListener('click', () => selectGuild(g.id, li));
    list.appendChild(li);
  }
  if (guilds.length) selectGuild(guilds[0].id, list.firstChild);
}

async function selectGuild(guildId, liEl) {
  state.guildId = guildId;
  [...el('guild-list').children].forEach((c) => c.classList.remove('active'));
  if (liEl) liEl.classList.add('active');

  const channels = await api(`/api/guilds/${guildId}/channels`);

  const textList = el('text-channel-list');
  textList.innerHTML = '';
  for (const c of channels.text) {
    const li = document.createElement('li');
    li.textContent = `# ${c.name}`;
    li.dataset.id = c.id;
    li.addEventListener('click', () => selectTextChannel(c.id, c.name, li));
    textList.appendChild(li);
  }

  const voiceList = el('voice-channel-list');
  voiceList.innerHTML = '';
  for (const c of channels.voice) {
    const li = document.createElement('li');
    li.className = 'voice-item';
    li.innerHTML = `<span>🔊 ${escapeHtml(c.name)}</span><span class="member-count">${c.memberCount}</span>`;
    li.dataset.id = c.id;
    li.dataset.name = c.name;
    li.addEventListener('click', () => onVoiceJoin(guildId, c.id, li));
    voiceList.appendChild(li);
  }
}

// ---- Chat ----

async function selectTextChannel(channelId, name, liEl) {
  state.textChannelId = channelId;
  [...el('text-channel-list').children].forEach((c) => c.classList.remove('active'));
  if (liEl) liEl.classList.add('active');

  el('chat-header').textContent = `# ${name}`;
  el('input-message').disabled = false;
  el('form-send').querySelector('button').disabled = false;

  const messages = await api(`/api/channels/${channelId}/messages`);
  const box = el('chat-messages');
  box.innerHTML = '';
  for (const m of messages) renderMessage(m);
  box.scrollTop = box.scrollHeight;
}

function renderMessage(m) {
  if (m.channelId && state.textChannelId && m.channelId !== state.textChannelId) return;
  const box = el('chat-messages');
  const wrap = document.createElement('div');
  wrap.className = 'message';

  const time = new Date(m.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const attachments = (m.attachments || [])
    .map((a) =>
      a.contentType?.startsWith('image/')
        ? `<img class="attachment" src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}" />`
        : `<a class="attachment" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a>`
    )
    .join('');

  wrap.innerHTML = `
    <img class="avatar" src="${escapeHtml(m.author.avatar)}" alt="" />
    <div class="message-body">
      <div class="meta"><span class="author">${escapeHtml(m.author.username)}</span>${time}</div>
      <div class="content">${escapeHtml(m.content)}</div>
      ${attachments}
    </div>`;
  box.appendChild(wrap);
}

async function onSendMessage(e) {
  e.preventDefault();
  if (!state.textChannelId) return;
  const input = el('input-message');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  await api(`/api/channels/${state.textChannelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

// ---- Voice ----

async function onVoiceJoin(guildId, channelId, liEl) {
  [...el('voice-channel-list').children].forEach((c) => c.classList.remove('active'));
  if (liEl) liEl.classList.add('active');
  await api('/api/voice/join', {
    method: 'POST',
    body: JSON.stringify({ guildId, channelId }),
  });
  await refreshVoiceStatus();
}

async function onVoiceLeave() {
  await api('/api/voice/leave', { method: 'POST' });
  await refreshVoiceStatus();
}

async function refreshVoiceStatus() {
  const status = await api('/api/voice/status');
  renderVoiceStatus(status);
  if (status.channelId) {
    const members = await api(`/api/voice/channel-members/${status.channelId}`);
    renderVoiceMembers(members);
  } else {
    el('voice-members').innerHTML = '';
  }
}

function renderVoiceStatus(status) {
  const box = el('voice-status');
  const stateEl = box.querySelector('.voice-state');
  const leaveBtn = el('btn-voice-leave');
  if (status.connected && status.channelName) {
    stateEl.textContent = `Đang treo tại: ${status.guildName} / ${status.channelName}`;
    leaveBtn.hidden = false;
  } else if (status.channelId) {
    stateEl.textContent = `Đang kết nối lại: ${status.channelName || status.channelId}...`;
    leaveBtn.hidden = false;
  } else {
    stateEl.textContent = 'Chưa kết nối voice';
    leaveBtn.hidden = true;
  }
}

function renderVoiceMembers(members) {
  const box = el('voice-members');
  box.innerHTML = members
    .map(
      (m) => `<div class="voice-member"><img class="avatar" src="${escapeHtml(m.avatar)}" alt="" />${escapeHtml(m.username)}</div>`
    )
    .join('');
}

// ---- Socket.IO live updates ----

function connectSocket() {
  const socket = io();

  socket.on('message:new', (message) => {
    if (message.channelId === state.textChannelId) {
      renderMessage(message);
      const box = el('chat-messages');
      box.scrollTop = box.scrollHeight;
    }
  });

  socket.on('voice:status', (status) => {
    renderVoiceStatus(status);
    if (status.channelId) {
      api(`/api/voice/channel-members/${status.channelId}`).then(renderVoiceMembers).catch(() => {});
    } else {
      el('voice-members').innerHTML = '';
    }
  });

  socket.on('voice:members', ({ members }) => renderVoiceMembers(members));

  socket.on('log', (line) => {
    const box = el('log-list');
    const p = document.createElement('div');
    p.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] ${line}`;
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
  });
}

// ---- Boot ----

(async function boot() {
  await initLogin();
  try {
    await initDashboard();
  } catch {
    showLogin();
  }
})();
