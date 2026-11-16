const root = document.querySelector('#online-screen');
const content = document.querySelector('#online-content');
const message = document.querySelector('#online-message');
const gameMessage = document.querySelector('#network-status');
const sessionKey = 'splendor-pokemon.online-room';
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const validCode = value => /^[\w-]{12}$/.test(value ?? '');
const roomPath = id => '/api/rooms/' + id;

let callback;
let room;
let token;
let timer;
let sending = false;
let disconnected = false;
let requestedRoom = '';
let opening = false;

async function request(path, body, seatToken) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(seatToken ? { Authorization: 'Bearer ' + seatToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(6500),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('联机服务尚未启动。');
  }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || '联机请求失败，请重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}

function showMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle('error', error);
  gameMessage.textContent = text;
  gameMessage.hidden = !text || gameMessage.dataset.active !== 'true';
}

export function inviteUrl() {
  if (!room) return '';
  const url = new URL('/', room.publicOrigin || location.origin);
  url.searchParams.set('room', room.id);
  return url.href;
}

export function inviteFields() {
  const url = inviteUrl();
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  return '<label class="invite-label">邀请链接<input type="url" value="' +
    escape(url) + '" readonly data-invite-url></label>' +
    '<button type="button" class="secondary" data-online="copy">复制邀请链接</button>' +
    (local ? '<p class="guidance">当前地址仅供本机测试，邀请其他设备时请配置共享地址。</p>' : '') +
    '<p class="invite-feedback guidance" aria-live="polite"></p>';
}

function renderEntry(id = '') {
  const joining = Boolean(id);
  const lastRoom = readSession()?.id;
  content.innerHTML = '<p>' + (joining ? '填写昵称即可加入邀请房间。' : '创建房间后，把邀请链接发给朋友。每局 2–4 人。') +
    '</p><form class="room-form"><label>你的昵称<input name="name" type="text" maxlength="18" autocomplete="nickname" required></label>' +
    (joining ? '' : '<label>房间码 <span>（加入已有房间时填写）</span><input name="room" type="text" maxlength="12" autocomplete="off"></label>') +
    '<div class="room-form-actions">' + (joining ? '' :
      '<button type="submit" value="create" class="primary">创建房间</button>') +
    '<button type="submit" value="join" class="' + (joining ? 'primary' : 'secondary') + '">加入房间</button></div></form>' +
    (!joining && lastRoom ? '<button type="button" class="secondary" data-online="resume">返回上次房间</button>' : '') +
    (joining ? '<button type="button" class="secondary" data-online="new">创建自己的房间</button>' : '');
}

function renderLobby() {
  const isOwner = room.you === room.owner;
  const last = room.members.length;
  content.innerHTML = '<div class="room-heading"><h2>房间大厅</h2><p>房间码 ' + escape(room.id) +
    ' · ' + last + ' / 4 人</p></div><ul class="room-seats">' +
    room.members.map(member => '<li><strong>' + escape(member.name) + '</strong><span>' +
      (member.id === room.owner ? '房主' : '训练家') + (member.id === room.you ? ' · 你' : '') + '</span></li>').join('') +
    '</ul><div class="invite-panel">' + inviteFields() + '</div>' +
    (isOwner ? '<button type="button" class="primary" data-online="start"' + (last < 2 ? ' disabled' : '') +
      '>开始联机对局</button><p class="guidance">至少两位训练家加入后，房主即可开局。</p>' :
      '<p class="guidance">等待房主开始对局。</p>');
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(sessionKey)); }
  catch { return null; }
}

function getToken(id) {
  try { return localStorage.getItem(sessionKey + '.' + id); }
  catch { return null; }
}

function storeSession() {
  try {
    localStorage.setItem(sessionKey, JSON.stringify({ id: room.id }));
    localStorage.setItem(sessionKey + '.' + room.id, token);
  } catch {}
}

function setRoomUrl(id) {
  const url = new URL(location.href);
  url.searchParams.delete('online');
  if (id) url.searchParams.set('room', id);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

function sync(next) {
  if (room?.id === next.id && room.revision >= next.revision) return;
  room = next;
  if (!room.state) renderLobby();
  callback(room);
}

function schedulePoll() {
  clearTimeout(timer);
  if (room) timer = setTimeout(poll, 1050);
}

async function poll() {
  const current = room;
  if (!current) return;
  try {
    const data = await request(roomPath(current.id) + '?since=' + current.revision, null, token);
    if (room?.id !== current.id) return;
    if (disconnected) {
      disconnected = false;
      showMessage('');
    }
    if (data.room) sync(data.room);
  } catch (error) {
    if (room?.id !== current.id) return;
    if (error.status === 404 || error.status === 401) {
      room = null;
      requestedRoom = '';
      setRoomUrl('');
      renderEntry();
      showMessage(error.message, true);
      callback(null);
    } else {
      disconnected = true;
      showMessage('联机连接中断，正在重新连接…', true);
    }
  } finally {
    schedulePoll();
  }
}

export function attachOnline(onUpdate) {
  callback = onUpdate;
}

export async function openOnline(id, newRoom = false) {
  if (opening) return;
  opening = true;
  if (newRoom) {
    clearTimeout(timer);
    room = null;
    setRoomUrl('');
  }
  requestedRoom = validCode(id) ? id : '';
  showMessage('');
  if (!requestedRoom || requestedRoom === room?.id) {
    if (room) {
      setRoomUrl(room.id);
      if (!room.state) renderLobby();
      callback(room);
      opening = false;
      return;
    }
  }
  try {
    const health = await request('/api/health');
    if (!health.online) throw new Error('联机服务尚未启动。');
  } catch {
    if (location.port === '8765' && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
      const url = new URL('http://127.0.0.1:8766/');
      url.searchParams.set(requestedRoom ? 'room' : 'online', requestedRoom || '1');
      content.innerHTML = '<p>联机大厅由独立的游戏服务提供。</p><a class="primary room-link" href="' +
        escape(url.href) + '">打开联机大厅</a>';
    } else {
      content.innerHTML = '<p>本站尚未配置联机服务器。可以返回主菜单玩单人或同屏对战。</p>';
    }
    opening = false;
    return;
  }
  if (requestedRoom) {
    const existingToken = getToken(requestedRoom);
    if (existingToken) {
      try {
        const data = await request(roomPath(requestedRoom), null, existingToken);
        token = existingToken;
        setRoomUrl(data.room.id);
        sync(data.room);
        storeSession();
        schedulePoll();
        opening = false;
        return;
      } catch (error) {
        if (error.status === 404) {
          requestedRoom = '';
          setRoomUrl('');
          showMessage(error.message, true);
        } else if (error.status !== 401) {
          showMessage('暂时无法连接房间，可以重新打开邀请链接重试。', true);
        }
      }
    }
  }
  renderEntry(requestedRoom);
  opening = false;
}

export function dismissRoomUrl() {
  setRoomUrl('');
}

async function join(event) {
  event.preventDefault();
  const fields = new FormData(event.target);
  const name = String(fields.get('name') ?? '').trim();
  const joining = Boolean(requestedRoom) || event.submitter?.value === 'join';
  const id = joining ? requestedRoom || String(fields.get('room') ?? '').trim() : '';
  if (joining && !validCode(id)) {
    showMessage('请输入邀请链接里的 12 位房间码。', true);
    return;
  }
  const buttons = event.target.querySelectorAll('button[type="submit"]');
  buttons.forEach(button => { button.disabled = true; });
  try {
    const data = await request(id ? roomPath(id) + '/join' : '/api/rooms', { name });
    token = data.token;
    setRoomUrl(data.room.id);
    showMessage('');
    sync(data.room);
    storeSession();
    schedulePoll();
  } catch (error) {
    showMessage(error.message || '无法连接联机服务。', true);
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function mutate(path, body) {
  if (!room || sending) return;
  sending = true;
  try {
    const data = await request(roomPath(room.id) + '/' + path, body, token);
    showMessage('');
    sync(data.room);
  } catch (error) {
    showMessage(error.message || '无法连接联机服务。', true);
    if (error.status === 409) void poll();
  } finally {
    sending = false;
  }
}

export function sendRoomAction(action) {
  return mutate('action', { revision: room?.revision, action: action ?? { type: 'PASS' } });
}

root.addEventListener('submit', join);
document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-online]');
  if (!button || button.disabled) return;
  if (button.dataset.online === 'start') void mutate('start', {});
  if (button.dataset.online === 'resume') void openOnline(readSession()?.id);
  if (button.dataset.online === 'new') {
    requestedRoom = '';
    setRoomUrl('');
    showMessage('');
    renderEntry();
  }
  if (button.dataset.online === 'copy') {
    const parent = button.parentElement;
    const input = parent.querySelector('[data-invite-url]');
    const feedback = parent.querySelector('.invite-feedback');
    try {
      await navigator.clipboard.writeText(input.value);
      feedback.textContent = '已复制。';
    } catch {
      input.focus();
      input.select();
      feedback.textContent = '链接已选中，可以手动复制。';
    }
  }
});
