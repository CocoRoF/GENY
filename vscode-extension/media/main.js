/* Geny sidebar webview — login → sessions → chat. Talks to the extension host
 * via postMessage (protocol mirrors chatView.ts). No framework; small + fast. */
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const state = {
    view: 'loading',
    serverUrl: '',
    account: '',
    session: null,
    isVscodeEnv: false,
    connector: 'offline',
    chatOpen: false,
    busy: false,
    messages: [], // {role:'user'|'agent'|'tool'|'system', text}
  };

  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'onclick') el.onclick = attrs[k];
      else if (k === 'onkeydown') el.onkeydown = attrs[k];
      else if (k === 'value') el.value = attrs[k];
      else if (k === 'type') el.type = attrs[k];
      else if (k === 'placeholder') el.placeholder = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) {
      if (kid == null) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  };

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ── views ────────────────────────────────────────────────────────

  function renderLogin() {
    const server = h('input', { type: 'text', placeholder: 'https://your-geny-host:port', value: state.serverUrl, class: 'in' });
    const user = h('input', { type: 'text', placeholder: 'username', class: 'in' });
    const pass = h('input', { type: 'password', placeholder: 'password', class: 'in' });
    const err = h('div', { class: 'err' });
    const submit = () => {
      err.textContent = '';
      post({ type: 'login', serverUrl: server.value, username: user.value, password: pass.value });
    };
    pass.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    root.replaceChildren(
      h('div', { class: 'pane' },
        h('div', { class: 'brand' }, 'Geny'),
        h('div', { class: 'sub' }, 'Log in to your Geny server'),
        server, user, pass,
        h('button', { class: 'btn primary', onclick: submit }, 'Log in'),
        err,
      ),
    );
    state._err = err;
  }

  function sessionRow(s, isVscode) {
    const dot = h('span', { class: 'dot ' + (s.status === 'stopped' ? 'off' : 'on') });
    const meta = [s.status];
    if (s.model) meta.push(s.model);
    return h('button', { class: 'row', onclick: () => post({ type: 'selectSession', sessionId: s.session_id }) },
      dot,
      h('div', { class: 'rowmain' },
        h('div', { class: 'rowtitle' }, s.session_name || (isVscode ? 'VSCode session' : s.session_id.slice(0, 8))),
        h('div', { class: 'rowmeta' }, meta.join(' · ')),
      ),
    );
  }

  function renderSessions(vscodeSessions, others) {
    const list = h('div', { class: 'list' });
    list.appendChild(h('div', { class: 'grouphdr' }, 'VSCode sessions'));
    if (!vscodeSessions.length) list.appendChild(h('div', { class: 'empty' }, 'None yet — create one to give the agent your workspace.'));
    vscodeSessions.forEach((s) => list.appendChild(sessionRow(s, true)));
    if (others.length) {
      list.appendChild(h('div', { class: 'grouphdr' }, 'Other agents (chat only)'));
      others.forEach((s) => list.appendChild(sessionRow(s, false)));
    }
    root.replaceChildren(
      h('div', { class: 'pane' },
        h('div', { class: 'topbar' },
          h('div', { class: 'who' }, state.account || ''),
          h('button', { class: 'link', onclick: () => post({ type: 'logout' }) }, 'Log out'),
        ),
        h('button', { class: 'btn primary', onclick: () => post({ type: 'newSession' }) }, '+ New VSCode session'),
        h('div', { class: 'refresh', onclick: () => post({ type: 'refreshSessions' }) }, '↻ Refresh'),
        list,
      ),
    );
  }

  function renderChat() {
    const log = h('div', { class: 'chatlog', id: 'chatlog' });
    state.messages.forEach((m) => log.appendChild(bubble(m)));
    const input = h('textarea', { class: 'chatin', placeholder: state.isVscodeEnv ? 'Ask the agent to work in your workspace…' : 'Message the agent…' });
    input.rows = 2;
    const send = () => {
      const t = input.value.trim();
      if (!t) return;
      pushMessage({ role: 'user', text: t });
      post({ type: 'send', text: t });
      input.value = '';
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    const connLabel = state.isVscodeEnv
      ? (state.connector === 'ready' ? '● workspace connected'
        : state.connector === 'connecting' ? '● connecting…' : '● workspace offline')
      : 'chat only (no local tools)';
    const connCls = state.connector === 'ready' ? 'conn on' : state.connector === 'connecting' ? 'conn mid' : 'conn off';
    root.replaceChildren(
      h('div', { class: 'pane chat' },
        h('div', { class: 'topbar' },
          h('button', { class: 'link', onclick: () => post({ type: 'backToSessions' }) }, '← Sessions'),
          h('div', { class: 'title2' }, (state.session && (state.session.session_name || 'VSCode')) || 'Chat'),
          h('span', { class: state.isVscodeEnv ? connCls : 'conn none' }, connLabel),
        ),
        log,
        h('div', { class: 'composer' },
          input,
          state.busy
            ? h('button', { class: 'btn stop', onclick: () => post({ type: 'stop' }) }, 'Stop')
            : h('button', { class: 'btn primary', onclick: send }, 'Send'),
        ),
      ),
    );
    scrollLog();
  }

  function bubble(m) {
    return h('div', { class: 'bubble ' + m.role }, m.text);
  }

  function scrollLog() {
    const el = document.getElementById('chatlog');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function pushMessage(m) {
    state.messages.push(m);
    const el = document.getElementById('chatlog');
    if (el) { el.appendChild(bubble(m)); scrollLog(); }
  }

  function render() {
    if (state.view === 'login') renderLogin();
    else if (state.view === 'sessions') renderSessions(state.vscodeSessions || [], state.others || []);
    else if (state.view === 'chat') renderChat();
    else root.replaceChildren(h('div', { class: 'pane' }, h('div', { class: 'sub' }, 'Loading…')));
  }

  // ── host → webview ────────────────────────────────────────────────

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'view':
        state.view = m.view;
        if (m.serverUrl != null) state.serverUrl = m.serverUrl;
        if (m.view === 'sessions') { state.vscodeSessions = m.vscodeSessions; state.others = m.others; }
        if (m.view === 'chat') {
          state.session = m.session; state.isVscodeEnv = m.isVscodeEnv;
          state.messages = []; state.busy = false; state.connector = 'offline';
        }
        render();
        break;
      case 'account':
        state.account = m.username;
        break;
      case 'connector':
        state.connector = m.state;
        if (state.view === 'chat') render();
        break;
      case 'status':
        state.busy = m.status === 'running' || m.status === 'starting';
        if (m.message && m.status !== 'idle') pushMessage({ role: 'system', text: m.message });
        if (state.view === 'chat') render();
        break;
      case 'log':
        handleLog(m);
        break;
      case 'result':
        // Final answer is also carried by RESPONSE logs; result is the structured holder.
        break;
      case 'done':
        state.busy = false;
        if (state.view === 'chat') render();
        break;
      case 'chatOpen':
        state.chatOpen = true;
        break;
      case 'chatClose':
        state.chatOpen = false;
        break;
      case 'error':
        if (state._err && state.view === 'login') state._err.textContent = m.message;
        else pushMessage({ role: 'system', text: '⚠ ' + m.message });
        break;
    }
  });

  function handleLog(m) {
    const lvl = (m.level || '').toUpperCase();
    if (lvl === 'RESPONSE') {
      let t = m.message || '';
      t = t.replace(/^SUCCESS:\s*/, '');
      if (t.trim()) pushMessage({ role: 'agent', text: t });
    } else if (lvl === 'TOOL') {
      const name = (m.metadata && m.metadata.tool_name) || 'tool';
      pushMessage({ role: 'tool', text: `⚙ ${name}` });
    }
    // TOOL_RES / STAGE / STREAM / etc. are progress noise — kept out of the bubble log.
  }

  post({ type: 'ready' });
  render();
})();
