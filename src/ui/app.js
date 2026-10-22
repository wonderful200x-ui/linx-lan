'use strict';
const $ = id => document.getElementById(id);
const paths = {
  image: 'M3 3h18v18H3zM3 17l5-5 4 4 3-3 6 6M16 7h.1', copy: 'M8 8h13v13H8zM16 8V3H3v13h5',
  phone: 'M7 2h10v20H7zM10 18h4',
  chat: 'M20 11.5a8 8 0 0 1-8 7.5H7l-4 3v-6a7 7 0 0 1-1-4.5A8 8 0 0 1 10 4h2a8 8 0 0 1 8 7.5Z M7 11h8 M7 14h5',
  transfer: 'M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4',
  settings: 'm9 3 1-1h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  plus: 'M12 5v14M5 12h14', search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  refresh: 'M20 10a8 8 0 0 0-14-5L3 8m0-5v5h5M4 14a8 8 0 0 0 14 5l3-3m0 5v-5h-5',
  computer: 'M3 4h18v13H3zM8 21h8M12 17v4', folder: 'M3 7V4h7l2 3h9v13H3z',
  file: 'M5 2h9l5 5v15H5zM14 2v6h5M8 13h8M8 17h6', send: 'm3 3 18 9-18 9 3-9-3-9ZM6 12h15',
  broadcast: 'M5 4a12 12 0 0 1 14 0M7 8a8 8 0 0 1 10 0M10 12a3 3 0 0 1 4 0M12 16v5M9 21h6',
  shield: 'm12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5zM8 12l3 3 5-6',
  close: 'm6 6 12 12M6 18 18 6', info: 'M12 11v6M12 7v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', arrow: 'M4 12h16m-6-6 6 6-6 6'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bytes = (n = 0) => { if (n < 1024) return n + ' B'; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i]; };
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const platform = value => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' }[value] || '终端');
const statusNames = { pending: '等待接收', sending: '正在发送', receiving: '正在接收', completed: '已完成', rejected: '已拒绝', cancelled: '已取消', failed: '传输失败' };
const active = t => ['pending', 'sending', 'receiving'].includes(t.status);
let state, selectedId = null, view = 'chat', filter = 'all', timelineKey = '', toastTimer, dragDepth = 0, unread = new Map(), seenMessageIds = new Set(), initial = true;
const draftsByPeer = new Map(), imagePreviews = new Map();
let sending = false, pasting = false;
function draftImages(id = selectedId) { return draftsByPeer.get(id) || []; }
function renderDrafts() {
  const drafts = draftImages();
  $('imageDrafts').hidden = !drafts.length;
  $('imageDrafts').innerHTML = drafts.map(d => `<div class="image-draft"><img src="${esc(d.preview)}" alt="待发送图片"><small>${bytes(d.size)}</small><button data-remove-image="${esc(d.id)}" aria-label="移除图片" ${sending ? 'disabled' : ''}>${icon('close')}</button></div>`).join('');
}
function updateSendButton() { $('sendMessage').disabled = sending || !currentPeer()?.online || (!$('messageInput').value.trim() && !draftImages().length); }
async function pasteImage() {
  const id = selectedId;
  if (!id || !currentPeer()?.online || view !== 'chat') { toast('请先选择一个在线终端', true); return; }
  if (pasting || sending) return;
  pasting = true;
  try {
    const draft = await window.linx.clipboardImage();
    if (!draft) { toast('剪贴板中没有图片，可以先截图或复制图片'); return; }
    draftsByPeer.set(id, [...draftImages(id), draft]);
    renderDrafts(); updateSendButton();
  } catch (e) { toast(e.message, true); }
  finally { pasting = false; }
}
function toast(text, error = false) { $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6000 : 3500); }
async function action(fn) { try { return await fn(); } catch (e) { toast(e.message || String(e), true); return undefined; } }
function peers() {
  const map = new Map(state.peers.map(p => [p.id, p]));
  for (const m of [...state.messages, ...state.transfers]) if (!map.has(m.peerId)) map.set(m.peerId, { id: m.peerId, name: m.peerName || '离线终端', online: false });
  return [...map.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
function currentPeer() { return peers().find(p => p.id === selectedId); }
function avatar(name, id, isOnline, extra = '') {
  const tone = [...(id || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % 4;
  return `<div class="avatar tone${tone} ${extra}">${esc((name || '?').slice(0, 1).toUpperCase())}${isOnline !== undefined ? `<i class="online-dot ${isOnline ? '' : 'offline-dot'}"></i>` : ''}</div>`;
}
function renderPeers() {
  const list = peers(), query = $('search').value.toLowerCase();
  $('peerCount').textContent = state.peers.filter(p => p.online).length;
  const visible = list.filter(p => p.name.toLowerCase().includes(query) || (p.address || '').includes(query));
  $('peers').innerHTML = visible.length ? visible.map(p => {
    const messages = state.messages.filter(m => m.peerId === p.id), last = messages.at(-1), count = unread.get(p.id) || 0;
    return `<button class="peer ${p.id === selectedId && view === 'chat' ? 'selected' : ''}" data-peer="${esc(p.id)}" aria-label="${esc(p.name)}${p.online ? '，在线' : '，离线'}">${avatar(p.name, p.id, p.online)}<div class="peer-info"><span class="peer-name">${esc(p.name)}</span><span class="peer-sub">${esc(last?.text || (p.online ? platform(p.platform) + ' · ' + p.address : '终端已离线'))}</span></div>${count ? `<span class="unread">${count > 99 ? '99+' : count}</span>` : `<span class="peer-tail">${last ? time(last.createdAt) : ''}</span>`}</button>`;
  }).join('') : `<div class="peer-empty">${icon('broadcast')}<p>${query ? '没有匹配的终端' : '正在发现终端'}</p><small>${query ? '试试其他名称或 IP 地址' : '在另一台电脑打开飞鼠<br>连接同一网络即可出现在这里'}</small></div>`;
}
function transferCard(t) {
  const percent = t.status === 'completed' ? 100 : t.total ? Math.min(100, Math.floor(t.bytes / t.total * 100)) : 0;
  const eta = t.speed > 0 ? Math.max(1, Math.ceil((t.total - t.bytes) / t.speed)) : 0;
  const remaining = eta ? (eta > 60 ? Math.ceil(eta / 60) + ' 分钟' : eta + ' 秒') : '';
  return `<article class="transfer-card ${esc(t.status)}">${imagePreviews.get(t.id) ? `<img class="sent-image" src="${esc(imagePreviews.get(t.id))}" alt="${esc(t.name)}">` : ''}<div class="transfer-card-top"><span class="file-icon ${t.fileCount !== 1 || !t.name.includes('.') ? 'folder' : ''}">${icon(t.fileCount !== 1 || !t.name.includes('.') ? 'folder' : 'file')}</span><div class="transfer-info"><div class="transfer-name" title="${esc(t.name)}">${esc(t.name)}</div><div class="transfer-details">${t.direction === 'incoming' ? '来自' : '发送给'} ${esc(t.peerName)} · ${bytes(t.total)} · ${t.fileCount} 个文件</div></div></div><progress max="100" value="${percent}" aria-label="${esc(t.name)} 传输进度 ${percent}%"></progress><div class="transfer-progress-meta"><strong>${statusNames[t.status] || esc(t.status)}${['sending', 'receiving'].includes(t.status) ? ' · ' + percent + '%' : ''}</strong><span>${['sending', 'receiving'].includes(t.status) ? `${bytes(t.speed)}/s${remaining ? ' · 约 ' + remaining : ''}` : time(t.createdAt)}</span></div>${t.currentFile && active(t) ? `<div class="transfer-file" title="${esc(t.currentFile)}">${esc(t.currentFile)}</div>` : ''}${t.error ? `<div class="transfer-error">${esc(t.error)}</div>` : ''}<div class="transfer-actions">${t.direction === 'incoming' && t.status === 'pending' ? `<button data-transfer="${esc(t.id)}" data-action="reject">拒绝</button><button class="accept" data-transfer="${esc(t.id)}" data-action="accept">接收文件</button>` : ''}${active(t) ? `<button data-transfer="${esc(t.id)}" data-action="cancel">取消传输</button>` : ''}${t.receiveDir ? `<button data-transfer="${esc(t.id)}" data-action="reveal">${t.status === 'completed' ? '打开文件夹' : '查看接收目录'}</button>` : ''}${t.direction === 'outgoing' && ['failed', 'cancelled', 'rejected'].includes(t.status) ? `<button data-transfer="${esc(t.id)}" data-action="retry">重新发送</button>` : ''}</div></article>`;
}
function renderActivity() {
  const count = state.transfers.filter(active).length;
  $('transferBadge').hidden = !count; $('transferBadge').textContent = count;
}
async function loadImagePreviews(list) {
  for (const t of list) {
    if (t.kind !== 'transfer' || t.status !== 'completed' || !/\.(png|jpe?g|webp|gif)$/i.test(t.name) || imagePreviews.has(t.id)) continue;
    if (imagePreviews.size > 200) break;
    imagePreviews.set(t.id, null);
    const preview = await window.linx.transferImage(t.id).catch(() => null);
    if (preview) { imagePreviews.set(t.id, preview); timelineKey = ''; render(); }
  }
}
function renderTimeline(p) {
  const list = [...state.messages.filter(m => m.peerId === p.id).map(m => ({ ...m, kind: 'message' })), ...state.transfers.filter(t => t.peerId === p.id).map(t => ({ ...t, kind: 'transfer' }))].sort((a, b) => a.createdAt - b.createdAt);
  const key = p.id + JSON.stringify(list) + state.config.name + p.name;
  if (key === timelineKey) return;
  const el = $('timeline'), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90 || !timelineKey.startsWith(p.id);
  timelineKey = key;
  if (!list.length) el.innerHTML = `<div class="chat-intro">${avatar(p.name, p.id)}<strong>和 ${esc(p.name)} 聊天</strong><p>发送消息、粘贴图片，或拖入文件。<br>文件通过局域网直接传给对方。</p></div>`;
  else {
    let day = '';
    el.innerHTML = list.map(item => {
      const d = new Date(item.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }), separator = d !== day ? `<div class="day-separator">${d}</div>` : ''; day = d;
      const own = item.direction === 'outgoing', name = own ? state.config.name : p.name;
      return `${separator}<div class="message-row ${own ? 'outgoing' : 'incoming'}">${avatar(name, own ? state.config.id : p.id)}<div class="message-content"><div class="message-meta"><span>${esc(name)}</span><span>${time(item.createdAt)}</span></div>${item.kind === 'message' ? `<div class="bubble">${esc(item.text)}</div>` : transferCard(item)}</div></div>`;
    }).join('');
  }
  if (atBottom) el.scrollTop = el.scrollHeight;
  loadImagePreviews(list);
}
function renderHistory() {
  const completed = state.transfers.filter(t => t.status === 'completed');
  $('transferSummary').innerHTML = `<div class="summary-cell"><span>进行中的传输</span><strong class="blue">${state.transfers.filter(active).length.toString().padStart(2, '0')}</strong></div><div class="summary-cell"><span>已完成的分享</span><strong>${completed.length.toString().padStart(2, '0')}</strong></div><div class="summary-cell"><span>累计传输数据</span><strong>${bytes(completed.reduce((n, t) => n + t.total, 0))}</strong></div>`;
  const list = state.transfers.filter(t => filter === 'all' || (filter === 'active' ? active(t) : t.status === 'completed'));
  $('transferHistory').innerHTML = list.length ? list.map(transferCard).join('') : `<div class="activity-empty"><span class="empty-icon">${icon('folder')}</span><strong>这里会记录每一次分享</strong><p>选择终端发送文件，或等待伙伴发送给你。</p></div>`;
}
function render() {
  if (!state) return;
  $('selfName').textContent = state.config.name;
  $('selfAddress').textContent = (state.addresses[0] || '127.0.0.1') + ':' + state.port;
  $('connectionAddress').textContent = state.addresses.length ? state.addresses.map(a => a + ':' + state.port).join(' / ') : '127.0.0.1:' + state.port + ' · 暂未检测到局域网网卡';
  $('warning').hidden = !state.warning; $('warning').textContent = state.warning;
  renderPeers(); renderActivity();
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const p = currentPeer(), chatting = view === 'chat' && p;
  $('welcome').hidden = view !== 'chat' || !!p; $('chat').hidden = !chatting; $('transferView').hidden = view !== 'transfers';
  if (view === 'transfers') { $('workspaceTitle').innerHTML = '<h2>文件</h2><p>传输记录</p>'; renderHistory(); }
  else if (p) {
    $('workspaceTitle').innerHTML = `<h2>${esc(p.name)}</h2><p>${p.online ? `${platform(p.platform)} · ${esc(p.address)}:${p.port}` : '终端已离线 · 对方上线后可继续发送'}</p>`;
    updateSendButton(); renderDrafts(); $('pasteImage').disabled = !p.online || sending; $('sendFile').disabled = !p.online; $('sendFolder').disabled = !p.online; $('messageInput').disabled = !p.online;
    renderTimeline(p);
  } else $('workspaceTitle').innerHTML = '<h2>飞鼠</h2><p>局域网聊天与文件传输</p>';
  const totalUnread = [...unread.values()].reduce((a, b) => a + b, 0); $('unreadBadge').hidden = !totalUnread; $('unreadBadge').textContent = totalUnread > 99 ? '99+' : totalUnread;
}
function applyState(value) {
  for (const m of value.messages) if (!initial && !seenMessageIds.has(m.id) && m.direction === 'incoming' && (selectedId !== m.peerId || view !== 'chat')) unread.set(m.peerId, (unread.get(m.peerId) || 0) + 1);
  seenMessageIds = new Set(value.messages.map(m => m.id)); initial = false; state = value; render();
}
function selectPeer(id) { selectedId = id; view = 'chat'; unread.delete(id); $('messageInput').value = ''; timelineKey = ''; render(); if (currentPeer()?.online) $('messageInput').focus(); }
$('peers').addEventListener('click', event => { const button = event.target.closest('[data-peer]'); if (button) selectPeer(button.dataset.peer); });
$('search').addEventListener('input', renderPeers);
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { view = button.dataset.view; if (view === 'chat' && selectedId) unread.delete(selectedId); render(); });
function showSettings() { if (!state) return; $('deviceName').value = state.config.name; $('downloadPath').textContent = state.config.downloadDir; $('settingsDialog').showModal(); }
$('settingsButton').addEventListener('click', showSettings); $('profileButton').addEventListener('click', showSettings);
for (const el of document.querySelectorAll('[data-close]')) el.addEventListener('click', () => $(el.dataset.close).close());
for (const id of ['connectButton', 'welcomeConnect']) $(id).addEventListener('click', () => $('connectDialog').showModal());
$('settingsForm').addEventListener('submit', event => { event.preventDefault(); action(async () => { applyState(await window.linx.rename($('deviceName').value)); $('settingsDialog').close(); toast('终端名称已更新'); }); });
$('chooseDownload').addEventListener('click', () => action(async () => { const value = await window.linx.pickDownload(); if (value) { applyState(value); $('downloadPath').textContent = value.config.downloadDir; } }));
$('connectForm').addEventListener('submit', event => {
  event.preventDefault(); $('connectSubmit').disabled = true;
  action(async () => { const id = await window.linx.connect($('peerAddress').value.trim(), Number($('peerPort').value)); applyState(await window.linx.snapshot()); selectPeer(id); $('connectDialog').close(); toast('已连接到伙伴的终端'); }).finally(() => { $('connectSubmit').disabled = false; });
});
$('rescanButton').addEventListener('click', () => action(async () => { await window.linx.rescan(); toast('正在重新发现局域网终端…'); }));
$('copyAddress').addEventListener('click', () => action(async () => { await navigator.clipboard.writeText((state.addresses[0] || '127.0.0.1') + ':' + state.port); toast('连接地址已复制'); }));
async function sendMessage() {
  const text = $('messageInput').value.trim(), id = selectedId, drafts = [...draftImages()];
  if (sending || !id || !currentPeer()?.online || (!text && !drafts.length)) return;
  sending = true; updateSendButton(); renderDrafts();
  await action(async () => {
    if (text) {
      await window.linx.message(id, text);
      if (selectedId === id && $('messageInput').value.trim() === text) $('messageInput').value = '';
    }
    if (drafts.length) {
      await window.linx.sendImages(id, drafts.map(d => d.id));
      const sent = new Set(drafts.map(d => d.id));
      draftsByPeer.set(id, draftImages(id).filter(d => !sent.has(d.id)));
      toast('图片已发送，等待对方接收');
    }
    applyState(await window.linx.snapshot());
  });
  sending = false; render(); $('messageInput').focus();
}
$('sendMessage').addEventListener('click', sendMessage);
$('pasteImage').addEventListener('click', pasteImage);
$('messageInput').addEventListener('input', updateSendButton);
$('messageInput').addEventListener('paste', event => {
  if ([...event.clipboardData.items].some(item => item.type.startsWith('image/'))) {
    event.preventDefault(); pasteImage();
  } else {
    const files = [...event.clipboardData.files].map(file => window.linx.filePath(file)).filter(Boolean);
    if (files.length && currentPeer()?.online) { event.preventDefault(); action(async () => { await window.linx.dropSend(selectedId, files); toast('已发送文件请求，等待对方接收'); }); }
  }
});
$('imageDrafts').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-image]'); if (!button || sending) return;
  const owner = selectedId, id = button.dataset.removeImage;
  action(async () => { await window.linx.discardImage(id); draftsByPeer.set(owner, draftImages(owner).filter(d => d.id !== id)); renderDrafts(); updateSendButton(); });
});
$('messageInput').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('sendMessage').disabled) sendMessage(); } });
for (const [id, folder] of [['sendFile', false], ['sendFolder', true]]) $(id).addEventListener('click', () => action(async () => {
  $(id).disabled = true; try { const sent = await window.linx.pickSend(selectedId, folder); if (sent) toast('已发送请求，等待对方接收'); } finally { $(id).disabled = !currentPeer()?.online; }
}));
document.addEventListener('click', event => {
  const button = event.target.closest('[data-transfer]'); if (!button || button.disabled) return;
  button.disabled = true;
  action(async () => {
    const id = button.dataset.transfer;
    switch (button.dataset.action) {
      case 'accept': await window.linx.accept(id, true); break;
      case 'reject': await window.linx.accept(id, false); break;
      case 'cancel': await window.linx.cancel(id); break;
      case 'reveal': { const error = await window.linx.reveal(id); if (error) throw new Error(error); break; }
      case 'retry': await window.linx.retry(id); toast('已重新发送请求，等待对方接收'); break;
    }
    applyState(await window.linx.snapshot());
  }).finally(() => { button.disabled = false; });
});
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === button)); renderHistory(); });
$('openDownloads').addEventListener('click', () => action(async () => { const error = await window.linx.openDownload(); if (error) throw new Error(error); }));
function fileDrag(event) { return Array.from(event.dataTransfer?.types || []).includes('Files'); }
window.addEventListener('dragenter', event => { if (!fileDrag(event)) return; event.preventDefault(); dragDepth++; const p = currentPeer(); if (view === 'chat' && p?.online) { $('dropPeer').textContent = p.name; $('dropOverlay').hidden = false; } });
window.addEventListener('dragover', event => { if (fileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = currentPeer()?.online ? 'copy' : 'none'; } });
window.addEventListener('dragleave', event => { if (fileDrag(event) && --dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true;
  if (view !== 'chat' || !currentPeer()?.online) { toast('请先选择一个在线终端', true); return; }
  action(async () => { const files = Array.from(event.dataTransfer.files).map(f => window.linx.filePath(f)).filter(Boolean); if (files.length) { await window.linx.dropSend(selectedId, files); toast('已发送请求，等待对方接收'); } });
});
if (window.linx) { window.linx.onState(applyState); action(async () => applyState(await window.linx.snapshot())); }
else { $('selfName').textContent = '请通过桌面应用启动'; $('selfAddress').textContent = '在项目目录运行 npm start'; $('connectionAddress').textContent = '桌面客户端启动后显示连接地址'; }

let androidLinks = [];
function showAndroidLink() { const selected = androidLinks[Number($('androidAddress').value)]; if (!selected) return; $('androidQR').src = selected.qr; $('androidQR').hidden = false; $('androidURL').textContent = selected.url; }
$('androidButton').addEventListener('click', () => action(async () => { const result = await window.linx.androidInstall(); androidLinks = result.links; if (!androidLinks.length) throw new Error('暂未检测到局域网地址，请先连接 Wi-Fi 或有线网络'); $('androidAddress').innerHTML = androidLinks.map((link, i) => `<option value="${i}">${esc(link.address)}</option>`).join(''); showAndroidLink(); $('androidDialog').showModal(); }));
$('androidAddress').addEventListener('change', showAndroidLink);
$('copyAndroidURL').addEventListener('click', () => action(async () => { const link = androidLinks[Number($('androidAddress').value)]; if (link) { await navigator.clipboard.writeText(link.url); toast('手机安装链接已复制'); } }));
