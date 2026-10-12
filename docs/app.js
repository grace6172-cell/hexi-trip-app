/* 荷西行 app：第一批（行程、地點、預約、準備→待辦） */
'use strict';

const API_URL = 'https://script.google.com/macros/s/AKfycbxy2p0Fgyqzs5S4ReD2-IfsrA9HxptMY5YoFt5P9kbKifGf7k2R5FTSLOEteszik4gDrA/exec';
// 每次發布都要跟 version.json 一起改；手機上的舊版看到不一樣就會自動換新版
const APP_VERSION = '2026.10.13-1';
const USERS = ['淇淇', '婷婷', '宜宜', '慧慧'];
const AVATAR = { 淇淇: '🐟', 婷婷: '🐨', 宜宜: '🐶', 慧慧: '🐯' };
// 舊代號（2026-10-12 改名前）→ 新名字；手機上還記著舊名字的會自動換
const OLD_NAMES = { 妹妹: '淇淇', 簡: '婷婷', 十一: '宜宜', 朱: '慧慧' };
/** 名字前面加上動物圖示；試算表裡只存名字 */
const who = (u) => (u ? (AVATAR[u] || '') + u : '');
const SLOTS = ['早上', '中午', '下午', '晚上'];
const SLOT_MIN = { 早上: 600, 中午: 780, 下午: 960, 晚上: 1200 };
const TYPES = ['景點', '餐廳', '酒吧', '甜點', '咖啡廳', '麵包店', '購物', '住宿'];
const RECO_TYPES = ['景點', '餐廳', '酒吧', '甜點', '咖啡廳', '麵包店'];
const STATUS = ['未訂', '已訂', '已取消'];
const CITY_COORD = { bcn: [41.3874, 2.1686], ams: [52.3676, 4.9041] };
const WALK_LIMIT = 10;
const WD_NAME = ['日', '一', '二', '三', '四', '五', '六'];

/* ---------------- 小工具 ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const truthy = (v) => v === true || v === 'TRUE' || v === 'true';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 私密模式等 */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

function madridNow() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    min: Number(p.hour) * 60 + Number(p.minute),
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  };
}
const weekdayOf = (date) => new Date(date + 'T12:00:00Z').getUTCDay();
const md = (date) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}`; };

function distM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const coordOf = (p) => (p && p['緯度'] !== '' && p['緯度'] != null ? [Number(p['緯度']), Number(p['經度'])] : null);
const walkMin = (m) => Math.max(1, Math.round((m * 1.3) / 80));

/* 營業時間：「一二三四五 09:00-20:00; 六 09:00-18:00; 日 休」 */
const WD_CHAR = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const hoursCache = new Map();
function parseHours(s) {
  if (!s) return null;
  if (hoursCache.has(s)) return hoursCache.get(s);
  const days = Array(7).fill(null);
  let any = false;
  String(s).split(';').map((x) => x.trim()).filter(Boolean).forEach((seg) => {
    const m = seg.match(/^(\S+)\s+(.+)$/);
    if (!m) return;
    const ds = m[1] === '每天' ? [0, 1, 2, 3, 4, 5, 6] : [...m[1]].map((c) => WD_CHAR[c]).filter((d) => d !== undefined);
    let ranges = [];
    if (m[2].trim() !== '休') {
      ranges = m[2].split(',').map((r) => {
        const t = r.trim().match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
        if (!t) return null;
        const a = Number(t[1]) * 60 + Number(t[2]);
        let b = Number(t[3]) * 60 + Number(t[4]);
        if (b <= a) b += 1440;
        return [a, b];
      }).filter(Boolean);
    }
    ds.forEach((d) => { days[d] = ranges; any = true; });
  });
  const out = any ? days : null;
  hoursCache.set(s, out);
  return out;
}
/** 回傳 {k: ok|warn|bad|unknown, t: 文字} */
function openState(place, wd, min, live) {
  const h = parseHours(place['營業時間（結構化）']);
  if (!h) return { k: 'unknown', t: '' };
  const inRange = (rs, m) => rs && rs.find(([a, b]) => m >= a && m < b);
  const prev = h[(wd + 6) % 7];
  const r = inRange(h[wd], min) || (prev ? inRange(prev.map(([a, b]) => [a - 1440, b - 1440]), min) : null);
  if (r) {
    if (r[1] - min <= 60) return { k: 'warn', t: live ? '快關了，衝！' : '快打烊' };
    return { k: 'ok', t: live ? '營業中' : '這時段有開' };
  }
  if (h[wd] && h[wd].length === 0) return { k: 'bad', t: live ? '今天店休，下次見 👋' : '店休' };
  if (h[wd] === null) return { k: 'unknown', t: '' };
  return { k: 'bad', t: live ? '休息中' : '這時段沒開' };
}

function mapsUrl(p) {
  if (p && p['Google 地圖連結']) return p['Google 地圖連結'];
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((p && p['名稱']) || '');
}

/* ---------------- 狀態 ---------------- */
const S = {
  auth: store.get('auth'),
  data: null,
  tab: store.get('tab') || 'trip',
  date: null,
  prepTab: 'todo',
  onlyMine: false,
  pf: { city: '巴塞隆納', type: '全部', region: '全部', q: '' },
  recoOpen: {},
  weather: {},
  error: '',
};

/* ---------------- API ---------------- */
async function fetchAll() {
  if (S.auth.demo) {
    const r = await fetch('demo-data.json');
    return r.json();
  }
  const r = await fetch(API_URL + '?action=all&key=' + encodeURIComponent(S.auth.key));
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '讀取失敗');
  return j.data;
}
async function post(body) {
  if (S.auth.demo) return { ok: true, row: null };
  S.pending = (S.pending || 0) + 1;
  S.lastWrite = Date.now();
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({}, body, { key: S.auth.key, user: S.auth.user })),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '儲存失敗');
    return j;
  } finally {
    S.pending -= 1;
    S.lastWrite = Date.now();
  }
}

/**
 * 從試算表重新抓資料。抓的期間如果有人在 app 裡改了東西，
 * 這份資料就是舊的，不能蓋掉畫面，等寫入完成後再抓一次。
 */
async function syncData(opts = {}) {
  if (!S.auth || S.auth.demo) return;
  if (S.syncing) { S.syncAgain = true; return; }
  S.syncing = true;
  const started = Date.now();
  try {
    const data = await fetchAll();
    if ((S.pending || 0) > 0 || (S.lastWrite || 0) >= started) {
      S.syncAgain = true;
    } else {
      keepRecentWrites(data);
      S.data = data;
      S.syncedAt = Date.now();
      store.set('cache', { at: S.syncedAt, demo: false, data });
      if (!$('#sheet-root').innerHTML) render(); else S.renderAfterSheet = true;
      if (opts.toast) toast('資料更新好了');
    }
  } catch (err) {
    S.lastError = '同步：' + err.message;
    if (opts.toast) toast('更新失敗：' + err.message);
  } finally {
    S.syncing = false;
    render.spin(false);
    if (S.syncAgain) { S.syncAgain = false; setTimeout(() => syncData(), 1500); }
  }
}

/**
 * 最近 2 分鐘內在這支手機上做的修改，同步回來的資料如果還沒反映（例如讀到舊的），
 * 就把修改再套上去，畫面不會「恢復原狀」（Q02／Q08）。
 */
const RECENT_MS = 120000;
function rememberWrite(w) {
  S.recent = (S.recent || []).filter((x) => Date.now() - x.at < RECENT_MS);
  S.recent.push(Object.assign({ at: Date.now() }, w));
}
function keepRecentWrites(data) {
  S.recent = (S.recent || []).filter((x) => Date.now() - x.at < RECENT_MS);
  S.recent.forEach((w) => {
    const list = data[w.sheet] || (data[w.sheet] = []);
    const row = list.find((r) => r.ID === w.id);
    if (row) Object.assign(row, w.fields || {});
    else if (w.row) list.push(Object.assign({}, w.row));
  });
}

const rows = (sheet) => (S.data && S.data[sheet]) || [];

/**
 * 行程和預約的時間互相同步（同一天、同一個地點）。試算表那邊由 Apps Script 改，
 * 這裡先把畫面上的另一邊改好，並記住，免得同步回來被蓋掉。
 */
function mirrorTime(fromSheet, id, time) {
  const src = rows(fromSheet).find((r) => r.ID === id);
  if (!src || !src['地點 ID']) return;
  const other = fromSheet === '行程' ? '預約' : '行程';
  rows(other).filter((r) => r['日期'] === src['日期'] && r['地點 ID'] === src['地點 ID'] && !truthy(r['已刪除']))
    .forEach((r) => { r['時間'] = time; rememberWrite({ sheet: other, id: r.ID, fields: { 時間: time } }); });
  render();
}
const placeById = (id) => rows('地點').find((p) => p.ID === id);

/** 先改畫面，再送出；失敗就還原 */
async function updateRow(sheet, id, fields, okMsg, undoFields) {
  const row = rows(sheet).find((r) => r.ID === id);
  if (!row) return;
  const before = {};
  Object.keys(fields).forEach((k) => { before[k] = row[k]; });
  Object.assign(row, fields);
  render();
  if (okMsg) toast(okMsg, undoFields ? () => updateRow(sheet, id, undoFields) : null);
  try {
    const j = await post({ action: 'update', sheet, id, fields });
    if (j.row) Object.assign(row, j.row);
    rememberWrite({ sheet, id, fields });
  } catch (err) {
    Object.assign(row, before);
    render();
    S.lastError = '修改：' + err.message;
    toast('沒存到：' + err.message);
  }
}
async function addRow(sheet, fields, okMsg) {
  const temp = Object.assign({ ID: 'tmp-' + Date.now() }, fields);
  if (sheet === '待辦') Object.assign(temp, { 完成: false, 已刪除: false, 建立者: S.auth.user });
  if (sheet === '行程') Object.assign(temp, { 已刪除: false, 新增者: S.auth.user, 來源: 'app 新增' });
  if (sheet === '購物') Object.assign(temp, { 已買: false, 已刪除: false, '按 ❤️ 的人': '', 來源: 'app 新增' });
  S.data[sheet].push(temp);
  render();
  if (okMsg) toast(okMsg);
  try {
    const j = await post({ action: 'add', sheet, fields });
    if (j.row) { Object.assign(temp, j.row); rememberWrite({ sheet, id: j.row.ID, row: Object.assign({}, temp) }); }
    else if (S.auth.demo) temp.ID = 'demo-' + Date.now();
    // 確認畫面上的這筆真的在 S.data 裡（萬一中間資料被換掉）
    if (!rows(sheet).some((r) => r.ID === temp.ID)) S.data[sheet].push(temp);
    render();
  } catch (err) {
    S.data[sheet] = S.data[sheet].filter((r) => r !== temp);
    render();
    S.lastError = '新增：' + err.message;
    toast('沒存到：' + err.message);
    syncData();
  }
}
async function toggleHeart(id) {
  const row = rows('購物').find((r) => r.ID === id);
  if (!row) return;
  const field = '按 ❤️ 的人';
  const before = row[field];
  const people = String(row[field] || '').split(/[,，、]\s*/).filter(Boolean);
  const i = people.indexOf(S.auth.user);
  if (i >= 0) people.splice(i, 1); else people.push(S.auth.user);
  row[field] = people.join('、');
  render();
  if (i < 0) toast('+1，買起來！');
  try {
    const j = await post({ action: 'heart', id });
    if (j.row) Object.assign(row, j.row);
    rememberWrite({ sheet: '購物', id, fields: { [field]: row[field] } });
  } catch (err) {
    S.lastError = '按 ❤️：' + err.message;
    row[field] = before;
    render();
    toast('沒存到：' + err.message);
  }
}
const hearts = (row) => String(row['按 ❤️ 的人'] || '').split(/[,，、]\s*/).filter(Boolean);

/* ---------------- 天氣（Open-Meteo，16 天內） ---------------- */
async function loadWeather(code) {
  if (!CITY_COORD[code] || S.weather[code]) return;
  S.weather[code] = 'loading';
  try {
    const [lat, lng] = CITY_COORD[code];
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe%2FMadrid&forecast_days=16`;
    const j = await (await fetch(url)).json();
    const out = {};
    (j.daily.time || []).forEach((d, i) => {
      out[d] = { code: j.daily.weather_code[i], hi: j.daily.temperature_2m_max[i], lo: j.daily.temperature_2m_min[i], rain: j.daily.precipitation_probability_max[i] };
    });
    S.weather[code] = out;
  } catch (e) {
    S.weather[code] = {};
  }
  render();
}
function wxIcon(c) {
  if (c === 0) return '☀️';
  if (c <= 2) return '🌤';
  if (c === 3) return '☁️';
  if (c <= 48) return '🌫';
  if (c <= 67) return '🌧';
  if (c <= 77) return '🌨';
  if (c <= 82) return '🌦';
  return '⛈';
}

/* ---------------- 每日資訊 ---------------- */
function dayInfo(date) {
  const d = rows('每日').find((r) => r['日期'] === date) || {};
  let code = d['城市代碼'] || 'bcn';
  let from = null, to = null;
  if (code === 'move') {
    const city = String(d['城市'] || '');
    const parts = city.split('→');
    const toCode = (s) => (/巴塞/.test(s) ? 'bcn' : /阿姆/.test(s) ? 'ams' : null);
    from = toCode(parts[0] || '');
    to = toCode(parts[1] || '');
  }
  const color = code === 'bcn' ? 'bcn' : code === 'ams' ? 'ams' : (to || from || 'bcn');
  const wxCity = code === 'move' ? (to || from) : code;
  return { row: d, code, from, to, color, wxCity };
}

/* ---------------- 畫面 ---------------- */
function render() {
  const app = $('#app');
  if (!S.auth) { app.innerHTML = loginView(); paintTiles(); return; }
  if (!S.data) {
    app.innerHTML = S.error
      ? `<div class="loading"><p class="error">${esc(S.error)}</p><p><button class="btn" data-act="retry">再試一次</button> <button class="btn ghost" data-act="logout">重新登入</button></p></div>`
      : '<div class="loading">讀取中…</div>';
    return;
  }
  if (!S.date) S.date = pickDefaultDate();
  const info = dayInfo(S.date);
  const cityVar = S.tab === 'trip' ? info.color : (S.tab === 'places' ? (S.pf.city === '阿姆斯特丹' ? 'ams' : 'bcn') : 'bcn');
  document.documentElement.style.setProperty('--city', `var(--${cityVar})`);

  let body = '';
  if (S.tab === 'trip') body = tripView(info);
  else if (S.tab === 'places') body = placesView();
  else if (S.tab === 'book') body = bookView();
  else if (S.tab === 'prep') body = prepView();
  else body = journalView();

  // 重畫前記住每一排橫向捲動的位置，重畫後放回去（不然點完會跳回第一格）
  const scrolls = {};
  app.querySelectorAll('.chips[data-sk]').forEach((el) => { scrolls[el.dataset.sk] = el.scrollLeft; });

  app.innerHTML = `
    <div id="ptr" class="ptr" aria-hidden="true">↓ 放開就重新整理</div>
    <header class="topbar">
      <div class="brand"><img src="icon-192.png" alt="" width="34" height="34"><h1>瘋女紙荷西行</h1>${S.auth.demo ? '<span class="demo-tag">示範</span>' : ''}</div>
      <div class="top-acts">
        <button class="icon-btn" id="sync-btn" data-act="refresh" aria-label="重新整理資料">🔄</button>
        <button class="who" data-act="settings" aria-label="設定">${esc(who(S.auth.user))}</button>
      </div>
    </header>
    <main>${body}</main>
    ${S.tab === 'prep' && S.prepTab === 'todo' ? '<button class="fab" data-act="add-todo">＋ 新增待辦</button>' : ''}
    ${S.tab === 'prep' && S.prepTab === 'shop' ? '<button class="fab" data-act="add-shop">＋ 新增想買的</button>' : ''}
    ${S.tab === 'trip' ? '<button class="fab" data-act="add-item">＋ 新增行程</button>' : ''}
    <nav class="tabbar">
      ${[['trip', '📅', '行程'], ['places', '📍', '地點'], ['book', '🎫', '預約'], ['prep', '🧳', '準備'], ['journal', '📝', '日誌']]
        .map(([k, ic, l]) => `<button class="tab${S.tab === k ? ' on' : ''}" data-act="tab" data-v="${k}"><span class="ic">${ic}</span>${l}</button>`).join('')}
    </nav>`;
  paintTiles();
  app.querySelectorAll('.chips[data-sk]').forEach((el) => {
    if (el.dataset.sk in scrolls) { el.scrollLeft = scrolls[el.dataset.sk]; return; }
    const on = el.querySelector('.chip.on');
    if (on) el.scrollLeft = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
  });
  render.spin(S.syncing);
  if (S.tab === 'trip' && info.wxCity) loadWeather(info.wxCity);
}
render.spin = (on) => { const b = $('#sync-btn'); if (b) b.classList.toggle('spin', !!on); };

function pickDefaultDate() {
  const days = rows('每日').map((r) => r['日期']);
  const today = madridNow().date;
  if (days.includes(today)) return today;
  if (today > days[days.length - 1]) return days[days.length - 1];
  return days[0];
}

/* ----- 登入 ----- */
function loginView() {
  const pick = S.loginUser || '';
  return `
    <div class="login">
      <div class="hero"><canvas data-tile="bcn"></canvas><div>
        <h1>瘋女紙荷西行</h1>
        <div class="muted">阿姆斯特丹 × 巴塞隆納｜2026/10/22–11/1</div>
      </div></div>
      <div class="field"><label>我是誰？</label>
        <div class="who-grid">${USERS.map((u) => `<button class="${pick === u ? 'on' : ''}" data-act="login-user" data-v="${esc(u)}">${esc(who(u))}</button>`).join('')}</div>
      </div>
      <div class="field"><label for="pass">旅行通行碼</label>
        <input id="pass" type="password" autocomplete="current-password" placeholder="四個人約好的那組">
      </div>
      ${S.loginError ? `<div class="error">${esc(S.loginError)}</div>` : ''}
      <button class="btn primary" data-act="login">出發 ✈️</button>
      ${/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '<button class="btn ghost" data-act="demo">先看示範資料</button>' : ''}
    </div>`;
}

/* ----- 行程 ----- */
function tripView(info) {
  const days = rows('每日');
  const dateChips = days.map((d) => {
    const c = d['城市代碼'] === 'ams' ? 'ams' : d['城市代碼'] === 'bcn' ? 'bcn' : 'sub';
    return `<button class="chip date-chip${d['日期'] === S.date ? ' on' : ''}" data-act="date" data-v="${d['日期']}">
      <span class="d num">${md(d['日期'])}</span><span class="w">週${esc(d['星期'])}</span><span class="dot" style="background:var(--${c})"></span></button>`;
  }).join('');

  const d = info.row;
  const wx = weatherText(info);
  let band = '';
  // 移動日用目的地的花紋（Q21）：10/24 → 巴塞花磚、10/28 → 阿姆藍花紋；回台灣那天用出發城市
  const tile = (info.code === 'bcn' || info.code === 'ams') ? info.code : (info.to || info.from);
  if (tile) band = `<canvas data-tile="${tile}"></canvas>`;

  const items = rows('行程').filter((r) => r['日期'] === S.date && !truthy(r['已刪除']));
  // 任何一天已經排進行程的地點，都不再出現在附近推薦（Q12）
  const usedIds = new Set(rows('行程').filter((r) => !truthy(r['已刪除'])).map((r) => r['地點 ID']).filter(Boolean));
  const bySlot = {};
  SLOTS.forEach((s) => { bySlot[s] = items.filter((r) => r['時段'] === s).sort((a, b) => (Number(a['排序']) || 0) - (Number(b['排序']) || 0) || String(a['時間']).localeCompare(String(b['時間']))); });
  const slotCity = slotCities(info, bySlot);

  const flights = items.filter((r) => r['類別'] === '航班');
  const infoPills = [];
  if (d['住宿']) infoPills.push(`<span class="pill mute">🏠 ${esc(d['住宿'])}</span>`);
  flights.forEach((f) => infoPills.push(`<span class="pill city">✈️ ${esc(f['時間'] || '')} ${esc(f['名稱'])}</span>`));

  const slotsHtml = SLOTS.map((slot) => {
    const list = bySlot[slot];
    let html = list.map((r) => itemHtml(r)).join('');
    if (!list.length) html += '<div class="free">今天放飛 🕊</div>';
    html += recoHtml(slot, bySlot, usedIds, slotCity[slot]);
    return `<section class="slot"><div class="slot-t">${slot}</div><div class="slot-c">${html}</div></section>`;
  }).join('');

  const buys = rows('購物').filter((r) => r['順路日期'] === S.date && !truthy(r['已刪除']))
    .sort((a, b) => hearts(b).length - hearts(a).length);
  const buyHtml = buys.length ? `
    <div class="section-h"><h2>🛍 今天順路可買</h2><span class="muted small">依 ❤️ 排序</span></div>
    <div class="card">${buys.map((b) => buyRowHtml(b)).join('')}</div>` : '';

  return `
    <div class="dates"><div class="chips" data-sk="dates">${dateChips}</div></div>
    <section class="banner">${band}<div class="banner-body">
      <div class="row1"><span class="city">${esc(d['城市'] || '')}</span><span class="weather num">${wx}</span></div>
      <div class="summary">${esc(d['Summary'] || '')}</div>
      ${d['提醒'] ? `<div class="memo">${esc(d['提醒'])}</div>` : ''}
      ${infoPills.length ? `<div class="info">${infoPills.join('')}</div>` : ''}
    </div></section>
    ${slotsHtml}
    ${buyHtml}`;
}

function weatherText(info) {
  if (!info.wxCity) return '';
  const w = S.weather[info.wxCity];
  if (!w || w === 'loading') return '天氣讀取中…';
  const x = w[S.date];
  if (!x) return '預報還沒出來（16 天內才有）';
  return `${wxIcon(x.code)} ${Math.round(x.hi)}° / ${Math.round(x.lo)}°・降雨 ${x.rain == null ? '–' : x.rain}%`;
}

function itemHtml(r) {
  const p = placeById(r['地點 ID']);
  const wd = weekdayOf(S.date);
  const badges = [];
  const bk = rows('預約').find((b) => b['日期'] === S.date && b['地點 ID'] && b['地點 ID'] === r['地點 ID']);
  if (bk) badges.push(`<span class="pill ${bk['狀態'] === '已訂' ? 'ok' : bk['狀態'] === '已取消' ? 'mute' : 'bad'}">${bk['狀態'] === '已訂' ? '✅ 已訂' : bk['狀態'] === '已取消' ? '已取消' : '⚠ 未訂'}</span>`);
  if (p && r['類別'] !== '航班') {
    const st = openState(p, wd, timeToMin(r['時間']) ?? SLOT_MIN[r['時段']], false);
    if (st.k !== 'unknown') badges.push(`<span class="pill ${st.k}">${esc(st.t)}</span>`);
  }
  if (p && isClosed(p)) badges.push('<span class="pill bad">⚠ 暫時關閉</span>');
  if (r['來源'] === 'app 新增' && r['新增者']) badges.push(`<span class="pill mute">${esc(who(r['新增者']))} 加的</span>`);
  return `<div class="card item">
    <div class="item-body">
      <button class="item-main" data-act="edit-item" data-v="${esc(r.ID)}">
        <span class="item-name">${r['時間'] ? `<span class="time">${esc(r['時間'])}</span>` : ''}<span>${itemIcon(r, p)} ${esc(r['名稱'])}</span></span>
        ${badges.length ? `<span class="badges">${badges.join('')}</span>` : ''}
        ${r['備註'] ? `<span class="item-note">${esc(r['備註'])}</span>` : ''}
      </button>
      ${p && r['類別'] !== '航班' ? `<button class="see-more" data-act="place" data-v="${esc(p.ID)}">看更多 ›</button>` : ''}
    </div>
    ${p ? `<a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>` : ''}
  </div>`;
}

/* 行程圖示：航班 ✈️；有連到地點就依地點類型（Q19）；其他 📌 */
const TYPE_ICON = { 景點: '🏛', 餐廳: '🍽', 酒吧: '🍸', 甜點: '🍰', 咖啡廳: '☕', 麵包店: '🥐', 購物: '🛍', 住宿: '🏨' };
function itemIcon(r, p) {
  if (r['類別'] === '航班') return '✈️';
  return (p && TYPE_ICON[p['類型']]) || '📌';
}
/** Google 地圖顯示暫時關閉或歇業的店（記在查證狀態欄）不推薦 */
const isClosed = (p) => /暫時關閉|永久停業|已歇業/.test(String(p['查證狀態'] || ''));

/**
 * 每個時段在哪座城市（Q14）。一般日子整天同一城；移動日以航班切開：
 * 起飛前的時段算出發城市、起飛那個時段在路上（不推薦）、抵達之後算目的地。
 */
const CITY_NAME = { bcn: '巴塞隆納', ams: '阿姆斯特丹' };
function slotCities(info, bySlot) {
  const out = {};
  if (info.code === 'bcn' || info.code === 'ams') { SLOTS.forEach((s) => { out[s] = CITY_NAME[info.code]; }); return out; }
  const flightIdx = SLOTS.map((s, i) => (bySlot[s].some((r) => r['類別'] === '航班') ? i : -1)).filter((i) => i >= 0);
  const dep = flightIdx.length ? flightIdx[0] : -1;
  const arr = flightIdx.length ? flightIdx[flightIdx.length - 1] : -1;
  SLOTS.forEach((s, i) => {
    let code = null;
    if (dep < 0) code = info.to || info.from;
    else if (i < dep) code = info.from;
    else if (i > arr || (i === arr && arr !== dep)) code = info.to;
    out[s] = code ? CITY_NAME[code] : null;
  });
  return out;
}
function timeToMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function anchorsFor(slot, bySlot, city) {
  const idx = SLOTS.indexOf(slot);
  const order = [idx, idx - 1, idx + 1, idx - 2, idx + 2, idx - 3, idx + 3].filter((i) => i >= 0 && i < 4);
  for (const i of order) {
    const pts = bySlot[SLOTS[i]].map((r) => placeById(r['地點 ID']))
      .filter((p) => p && p['類型'] !== '交通' && p['城市'] === city).map(coordOf).filter(Boolean);
    if (pts.length) return pts;
  }
  const home = rows('地點').find((p) => p['類型'] === '住宿' && p['城市'] === city);
  if (home && coordOf(home)) return [coordOf(home)];
  return [];
}

function recoHtml(slot, bySlot, usedIds, city) {
  if (!city) return '';
  const anchors = anchorsFor(slot, bySlot, city);
  if (!anchors.length) {
    return city === '阿姆斯特丹' ? '<div class="reco"><div class="reco-h">附近還沒有口袋名單，敲 🐟淇淇 👀</div></div>' : '';
  }
  const wd = weekdayOf(S.date);
  const min = SLOT_MIN[slot];
  const list = [];
  rows('地點').forEach((p) => {
    if (!RECO_TYPES.includes(p['類型']) || usedIds.has(p.ID) || p['城市'] !== city || isClosed(p)) return;
    const c = coordOf(p);
    if (!c) return;
    const best = Math.min(...anchors.map((a) => distM(a, c)));
    const w = walkMin(best);
    if (w > WALK_LIMIT) return;
    const st = openState(p, wd, min, false);
    if (st.k === 'bad') return;
    list.push({ p, w, st });
  });
  if (!list.length) return '';
  list.sort((a, b) => (Number(b.p['評分']) || 0) - (Number(a.p['評分']) || 0) || a.w - b.w);
  const starId = list.find((x) => Number(x.p['評分']))?.p.ID;
  const key = S.date + slot;
  const open = S.recoOpen[key];
  const shown = open ? list : list.slice(0, 3);
  return `<div class="reco">
    <div class="reco-h"><span>附近推薦（口袋名單）</span><span>${list.length} 個</span></div>
    ${shown.map(({ p, w, st }) => `
      <div class="reco-row">
        <span class="star">${p.ID === starId ? '★' : ''}</span>
        <button class="reco-info" data-act="place" data-v="${esc(p.ID)}" data-slot="${slot}"><div class="nm">${TYPE_ICON[p['類型']] || ''} ${esc(p['名稱'])}</div>
          <div class="meta num">${esc(p['類型'])}・步行 ${w} 分${Number(p['評分']) ? `・${Number(p['評分']).toFixed(1)}★` : ''}${p['價位'] ? `・💶${esc(p['價位'])}` : ''}${truthy(p['已去過']) ? '・去過了' : ''}${st.k === 'warn' ? '・快打烊' : ''}・看更多 ›</div></button>
        <div class="acts">
          <a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>
          <button class="icon-btn" data-act="add-reco" data-v="${esc(p.ID)}" data-slot="${slot}" aria-label="加進行程">＋</button>
        </div>
      </div>`).join('')}
    ${list.length > 3 ? `<button class="more" data-act="reco-more" data-v="${key}">${open ? '收起來' : `再看 ${list.length - 3} 個`}</button>` : ''}
  </div>`;
}

function buyRowHtml(b) {
  const hs = hearts(b);
  const mine = hs.includes(S.auth.user);
  const p = placeById(b['地點 ID']);
  return `<div class="buy-row">
    <div style="min-width:0"><div>${esc(b['商品'])}</div><div class="muted small">${esc(b['哪裡買'] || '')}${b['參考價'] ? '・' + esc(b['參考價']) : ''}</div></div>
    <div style="display:flex;gap:6px;align-items:center">
      ${p ? `<a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>` : ''}
      <button class="heart${mine ? ' on' : ''}" data-act="heart" data-v="${esc(b.ID)}">❤️ ${hs.length}</button>
    </div></div>`;
}

/* ----- 地點 ----- */
function placesView() {
  const f = S.pf;
  const now = madridNow();
  const all = rows('地點').filter((p) => TYPES.includes(p['類型']) && p['城市'] === f.city);
  const regions = ['全部', ...new Set(all.map((p) => p['區域']).filter(Boolean))];
  if (!regions.includes(f.region)) f.region = '全部';
  const q = f.q.trim().toLowerCase();
  const fp = f.price || '全部';
  const list = all.filter((p) => (f.type === '全部' || p['類型'] === f.type) && (f.region === '全部' || p['區域'] === f.region)
    && (fp === '全部' || p['價位'] === fp)
    && (!q || [p['名稱'], p['特色'], p['區域'], p['地址']].join(' ').toLowerCase().includes(q)));
  const showPrice = f.type === '全部' || FOOD_TYPES.includes(f.type);
  list.sort((a, b) => Number(truthy(a['已去過'])) - Number(truthy(b['已去過'])) || (Number(b['評分']) || 0) - (Number(a['評分']) || 0));
  const counts = {};
  all.forEach((p) => { counts[p['類型']] = (counts[p['類型']] || 0) + 1; });

  return `
    <div class="filters">
      <div class="seg">${['巴塞隆納', '阿姆斯特丹'].map((c) => `<button class="${f.city === c ? 'on' : ''}" data-act="pf-city" data-v="${c}">${c}</button>`).join('')}</div>
      <input class="search" id="pq" type="search" placeholder="搜尋店名、特色、區域" value="${esc(f.q)}">
      <div class="chips" data-sk="ptype">${['全部', ...TYPES].filter((t) => t === '全部' || counts[t]).map((t) => `<button class="chip${f.type === t ? ' on' : ''}" data-act="pf-type" data-v="${t}">${t}${t !== '全部' ? ` ${counts[t]}` : ''}</button>`).join('')}</div>
      ${regions.length > 2 ? `<div class="chips" data-sk="pregion">${regions.map((r) => `<button class="chip${f.region === r ? ' on' : ''}" data-act="pf-region" data-v="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
      ${showPrice ? `<div class="chips" data-sk="pprice">${['全部', '低', '中', '高'].map((v) => `<button class="chip${fp === v ? ' on' : ''}" data-act="pf-price" data-v="${v}">${v === '全部' ? '💶 不限價位' : `💶 ${v}價位`}</button>`).join('')}</div>` : ''}
    </div>
    <div class="muted small" style="margin:2px 2px 10px">當地現在 ${String(Math.floor(now.min / 60)).padStart(2, '0')}:${String(now.min % 60).padStart(2, '0')}（週${WD_NAME[now.wd]}），燈號照這個時間算</div>
    <div class="list">${list.length ? list.map((p) => placeHtml(p, now)).join('') : '<div class="empty">沒有符合的地點</div>'}</div>`;
}
/** 價位（以當地水平、每人）：💶 中 €20–30／人；Google 沒資料的標「估計」 */
const FOOD_TYPES = ['餐廳', '酒吧', '甜點', '咖啡廳', '麵包店'];
function priceText(p) {
  if (!p['價位']) return '';
  const range = String(p['價格區間'] || '');
  return /估計/.test(range) ? `💶 ${p['價位']}（估計）` : `💶 ${p['價位']}${range ? ' ' + range : ''}`;
}
/** 住宿卡片：入住退房、備品直接攤開（Q11） */
function lodgingHtml(p) {
  const lines = (s) => String(s || '').split('｜').filter(Boolean).map((x) => `<div>${esc(x.trim())}</div>`).join('');
  return `<article class="card place lodging">
    <div class="place-top">
      <div class="nm">🏨 ${esc(p['名稱'])}<small>${esc(p['城市'])}・住宿</small></div>
      <a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>
    </div>
    <div class="lodge-sec"><div class="lodge-h">🕒 入住／退房</div>${lines(p['營業提醒'])}</div>
    <div class="lodge-sec"><div class="lodge-h">📍 地址</div>${lines(p['地址'])}</div>
    <div class="lodge-sec"><div class="lodge-h">🧴 房型與備品</div>${lines(p['特色'])}</div>
    ${p['交通'] ? `<div class="lodge-sec"><div class="lodge-h">🚇 交通</div><div class="hours">${esc(p['交通'])}</div></div>` : ''}
    ${p['官網'] ? `<a class="btn" href="${esc(p['官網'])}" target="_blank" rel="noopener">🌐 官網</a>` : ''}
  </article>`;
}
function placeHtml(p, now) {
  if (p['類型'] === '住宿') return lodgingHtml(p);
  const st = openState(p, now.wd, now.min, true);
  const visited = truthy(p['已去過']);
  return `<article class="card place${visited ? ' visited' : ''}">
    <div class="place-top">
      <button class="check${visited ? ' on' : ''}" data-act="visited" data-v="${esc(p.ID)}" aria-label="已去過">${visited ? '✓' : ''}</button>
      <div class="nm">${esc(p['名稱'])}<small>${esc(p['類型'])}・${esc(p['區域'] || '')}</small></div>
      <a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>
    </div>
    <div class="badges">
      ${isClosed(p) ? '<span class="pill bad">⚠ 暫時關閉</span>' : ''}
      ${Number(p['評分']) ? `<span class="pill mute num">★ ${Number(p['評分']).toFixed(1)}</span>` : ''}
      ${priceText(p) ? `<span class="pill mute num">${esc(priceText(p))}</span>` : ''}
      ${st.k !== 'unknown' ? `<span class="pill ${st.k}">${esc(st.t)}</span>` : '<span class="pill mute">營業時間待查</span>'}
      ${visited ? '<span class="pill ok">打卡完成 ✅</span>' : ''}
    </div>
    ${p['特色'] ? `<div class="feat">${esc(p['特色'])}</div>` : ''}
    ${p['官網'] ? `<a class="btn" href="${esc(p['官網'])}" target="_blank" rel="noopener">🌐 官網</a>` : ''}
    <details><summary>營業時間・交通 ▾</summary>
      ${p['營業提醒'] ? `<div class="hours">${esc(p['營業提醒'])}</div>` : ''}
      ${p['交通'] ? `<div class="hours" style="margin-top:6px">🚇 ${esc(p['交通'])}</div>` : ''}
      ${p['地址'] ? `<div style="margin-top:6px">📍 ${esc(p['地址'])}</div>` : ''}
      ${p['查證狀態'] ? `<div style="margin-top:6px">${esc(p['查證狀態'])}</div>` : ''}
    </details>
  </article>`;
}

/* ----- 預約 ----- */
// 試算表欄位名稱不變（票在誰手上／票券位置），畫面上改叫「小幫手」「訂位資訊」
const BOOK_FILTERS = [['all', '全部'], ['todo', '未訂'], ['done', '已訂'], ['mine', '我是小幫手'], ['nobody', '還沒有小幫手']];
function bookView() {
  const all = rows('預約').slice().sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])) || String(a['時間'] || '99').localeCompare(String(b['時間'] || '99')));
  const count = (s) => all.filter((r) => r['狀態'] === s).length;
  const f = S.bookFilter || 'all';
  const list = all.filter((r) => {
    if (f === 'todo') return r['狀態'] === '未訂';
    if (f === 'done') return r['狀態'] === '已訂';
    if (f === 'mine') return r['票在誰手上'] === S.auth.user;
    if (f === 'nobody') return !r['票在誰手上'] && r['狀態'] !== '已取消';
    return true;
  });
  let lastDate = '';
  const html = list.map((r) => {
    let head = '';
    if (r['日期'] !== lastDate) { lastDate = r['日期']; head = `<div class="book-date num">${md(r['日期'])}（週${WD_NAME[weekdayOf(r['日期'])]}）</div>`; }
    const si = STATUS.indexOf(r['狀態']);
    return `${head}<article class="card book${r['狀態'] === '已取消' ? ' cancelled' : ''}">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div class="bk-name">${r['時間'] ? `<span class="num" style="color:var(--city)">${esc(r['時間'])}</span> ` : ''}${esc(r['項目'])}</div>
          <div class="bk-meta">${r['票在誰手上'] ? `🙋 小幫手：${esc(who(r['票在誰手上']))}` : '🙋 小幫手哪位？'}</div>
          ${r['票券位置'] ? `<div class="bk-meta">📎 訂位資訊：${esc(r['票券位置'])}</div>` : ''}
          ${r['備註'] ? `<div class="bk-meta">${esc(r['備註'])}</div>` : ''}
          ${r['更新者'] ? `<div class="bk-meta">最後由 ${esc(who(r['更新者']))} 更新</div>` : ''}
        </div>
        <button class="icon-btn" data-act="edit-book" data-v="${esc(r.ID)}" aria-label="編輯">✏️</button>
      </div>
      <div class="status-seg">${STATUS.map((s, i) => `<button class="s${i}${si === i ? ' on' : ''}" data-act="book-status" data-v="${esc(r.ID)}" data-s="${s}">${s}</button>`).join('')}</div>
    </article>`;
  }).join('');
  return `
    <div class="section-h"><h2>預約</h2>
      <div class="summary-strip"><span class="pill bad">未訂 ${count('未訂')}</span><span class="pill ok">已訂 ${count('已訂')}</span>${count('已取消') ? `<span class="pill mute">已取消 ${count('已取消')}</span>` : ''}</div>
    </div>
    <div class="chips" data-sk="bookf">${BOOK_FILTERS.map(([k, l]) => `<button class="chip${f === k ? ' on' : ''}" data-act="book-filter" data-v="${k}">${l}</button>`).join('')}</div>
    ${html || `<div class="empty">${f === 'mine' ? '你還沒認領任何預約，點 ✏️ 選自己當小幫手' : '這裡空空的'}</div>`}`;
}

/* ----- 準備 ----- */
function prepView() {
  const seg = `<div class="seg" style="margin-top:6px">${[['todo', '待辦'], ['shop', '購物'], ['tools', '工具箱']].map(([k, l]) => `<button class="${S.prepTab === k ? 'on' : ''}" data-act="prep-tab" data-v="${k}">${l}</button>`).join('')}</div>`;
  if (S.prepTab === 'shop') return seg + shopView();
  if (S.prepTab === 'tools') return seg + toolsView();
  const all = rows('待辦').filter((r) => !truthy(r['已刪除']));
  const list = all.filter((r) => !S.onlyMine || r['負責人'] === S.auth.user)
    .sort((a, b) => Number(truthy(a['完成'])) - Number(truthy(b['完成'])));
  const left = all.filter((r) => !truthy(r['完成'])).length;
  return seg + `
    <div class="section-h"><h2>${left ? `還有 ${left} 件` : '全部搞定，安心出發 ✈️'}</h2>
      <button class="chip${S.onlyMine ? ' on' : ''}" data-act="only-mine">只看我的</button></div>
    <div class="list">${list.map((r) => {
      const done = truthy(r['完成']);
      return `<div class="card todo${done ? ' done' : ''}">
        <button class="check${done ? ' on' : ''}" data-act="todo-done" data-v="${esc(r.ID)}" aria-label="完成">${done ? '✓' : ''}</button>
        <button class="body" data-act="edit-todo" data-v="${esc(r.ID)}">
          <div class="t">${esc(r['項目'])}</div>${r['說明'] ? `<div class="d">${esc(r['說明'])}</div>` : ''}
        </button>
        <button class="owner${r['負責人'] === S.auth.user ? ' me' : ''}" data-act="owner" data-v="${esc(r.ID)}" aria-label="換負責人">${esc(r['負責人'] ? who(r['負責人']) : '大家')} ▾</button>
      </div>`;
    }).join('') || '<div class="empty">沒有待辦</div>'}</div>`;
}

/* ----- 準備 → 購物 ----- */
const SHOP_FILTERS = [['all', '全部'], ['todo', '還沒買'], ['mine', '我想買的'], ['done', '已買']];
function shopDateLabel(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${md(v)} 順路`;
  return `${v}可買`;
}
function shopView() {
  const all = rows('購物').filter((r) => !truthy(r['已刪除']));
  const f = S.shopFilter || 'all';
  const list = all.filter((r) => {
    if (f === 'todo') return !truthy(r['已買']);
    if (f === 'done') return truthy(r['已買']);
    if (f === 'mine') return hearts(r).includes(S.auth.user);
    return true;
  }).sort((a, b) => Number(truthy(a['已買'])) - Number(truthy(b['已買'])) || hearts(b).length - hearts(a).length);
  const bought = all.filter((r) => truthy(r['已買'])).length;
  return `
    <div class="section-h"><h2>想買 ${all.length} 樣・已買 ${bought}</h2><span class="muted small">❤️ 越多越優先</span></div>
    <div class="chips" data-sk="shopf">${SHOP_FILTERS.map(([k, l]) => `<button class="chip${f === k ? ' on' : ''}" data-act="shop-filter" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="list">${list.map((r) => shopItemHtml(r)).join('') || '<div class="empty">這裡空空的</div>'}</div>`;
}
function shopItemHtml(r) {
  const hs = hearts(r);
  const mine = hs.includes(S.auth.user);
  const done = truthy(r['已買']);
  const p = placeById(r['地點 ID']);
  const warn = /⚠|待查證/.test(String(r['查證狀態'] || ''));
  return `<article class="card shop${done ? ' done' : ''}">
    <div class="shop-top">
      <button class="check${done ? ' on' : ''}" data-act="shop-bought" data-v="${esc(r.ID)}" aria-label="已買">${done ? '✓' : ''}</button>
      <button class="body" data-act="shop-detail" data-v="${esc(r.ID)}">
        <div class="t">${esc(r['商品'])}</div>
        <div class="d">${esc(r['哪裡買'] || '')}${r['參考價'] ? `・${esc(r['參考價'])}` : ''}</div>
      </button>
      ${p ? `<a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>` : ''}
    </div>
    <div class="shop-bottom">
      <div class="badges">
        ${r['順路日期'] ? `<span class="pill city">${esc(shopDateLabel(r['順路日期']))}</span>` : ''}
        ${warn ? '<span class="pill mute">待查證</span>' : ''}
        ${hs.length ? `<span class="muted small">${esc(hs.map(who).join('、'))}</span>` : ''}
      </div>
      <button class="heart${mine ? ' on' : ''}" data-act="heart" data-v="${esc(r.ID)}">❤️ ${hs.length}</button>
    </div>
  </article>`;
}
function shopDetailSheet(id) {
  const r = rows('購物').find((x) => x.ID === id);
  if (!r) return;
  const p = placeById(r['地點 ID']);
  openSheet(`
    <h3>${esc(r['商品'])}</h3>
    <div class="list small">
      ${r['哪裡買'] ? `<div>🛍 ${esc(r['哪裡買'])}</div>` : ''}
      ${p && p['地址'] ? `<div>📍 ${esc(p['地址'])}</div>` : ''}
      ${r['參考價'] ? `<div>💶 ${esc(r['參考價'])}</div>` : ''}
      ${r['說明'] ? `<div>${esc(r['說明'])}</div>` : ''}
      ${r['順路日期'] ? `<div>📅 ${esc(shopDateLabel(r['順路日期']))}</div>` : ''}
      ${hearts(r).length ? `<div>❤️ ${esc(hearts(r).map(who).join('、'))}</div>` : ''}
      ${r['來源'] ? `<div class="muted">來源：${esc(r['來源'])}${r['查證狀態'] ? `｜${esc(r['查證狀態'])}` : ''}</div>` : ''}
    </div>
    <div class="acts">
      <button class="btn danger" data-act="shop-remove" data-v="${esc(id)}">移除</button>
      <div class="right">${p ? `<a class="btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener">🗺 地圖</a>` : ''}<button class="btn" data-act="sheet-close">關閉</button></div>
    </div>`);
}
function shopAddSheet() {
  const days = rows('每日').filter((d) => d['城市代碼'] === 'bcn' || d['城市代碼'] === 'ams' || /巴塞|阿姆/.test(d['城市']));
  const shops = rows('地點').filter((p) => p['類型'] === '購物');
  openSheet(`
    <h3>新增想買的</h3>
    <div class="field"><label for="f-name">商品</label><input id="f-name" placeholder="例：橄欖油"></div>
    <div class="field"><label for="f-where">哪裡買</label><input id="f-where" placeholder="例：超市、波蓋利亞市場"></div>
    <div class="field"><label for="f-price">參考價</label><input id="f-price" placeholder="例：€5"></div>
    <div class="field"><label for="f-place">對應地點（可不選）</label><select id="f-place"><option value="">不指定</option>${shops.map((p) => `<option value="${esc(p.ID)}">${esc(p['名稱'])}</option>`).join('')}</select></div>
    <div class="field"><label for="f-day">哪天順路</label><select id="f-day"><option value="">不限</option><option>超市</option>${days.map((d) => `<option value="${d['日期']}">${md(d['日期'])}（週${esc(d['星期'])}）${esc(d['城市'])}</option>`).join('')}</select></div>
    <div class="field"><label for="f-desc">說明</label><textarea id="f-desc" placeholder="口味、要買給誰…"></textarea></div>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">取消</button><button class="btn primary" data-act="shop-save">新增</button></div></div>`,
  () => $('#f-name').focus());
}

/* ----- 準備 → 工具箱 ----- */
const TOOL_ORDER = ['交通', '緊急', '保險', '分帳', '翻譯'];
const TOOL_ICON = { 緊急: '🆘', 保險: '🛡', 交通: '🚇', 分帳: '💶', 翻譯: '🗣' };
const PHRASES = [
  ['你好', 'Hola', 'Hallo'],
  ['謝謝', 'Gracias', 'Dank je wel'],
  ['請給我們菜單', 'La carta, por favor', 'Mag ik de menukaart?'],
  ['你推薦什麼？', '¿Qué nos recomienda?', 'Wat raadt u aan?'],
  ['我們有四個人', 'Somos cuatro personas', 'We zijn met z’n vieren'],
  ['我有訂位，名字是＿＿', 'Tengo una reserva a nombre de ＿＿', 'Ik heb gereserveerd op naam van ＿＿'],
  ['我對＿＿過敏', 'Soy alérgica a ＿＿', 'Ik ben allergisch voor ＿＿'],
  ['不要加冰', 'Sin hielo, por favor', 'Zonder ijs, alstublieft'],
  ['買單', 'La cuenta, por favor', 'Mag ik de rekening?'],
  ['可以刷卡嗎？', '¿Puedo pagar con tarjeta?', 'Kan ik met kaart betalen?'],
  ['這個多少錢？', '¿Cuánto cuesta?', 'Hoeveel kost dit?'],
  ['廁所在哪裡？', '¿Dónde está el baño?', 'Waar is het toilet?'],
  ['請幫我叫救護車', 'Llame a una ambulancia, por favor', 'Bel een ambulance, alstublieft'],
];
function phoneOf(text) {
  const m = String(text || '').match(/\+?\d[\d\s-]{1,18}\d/);
  return m ? m[0].replace(/[\s-]/g, '') : null;
}
/* ----- 工具箱 → 交通 ----- */
// 巴塞常用車站（座標來自 OpenStreetMap，2026-10-13 取）；地點沒寫交通時用來找最近的站
const BCN_STATIONS = [
  ['Espanya', 'L1/L3', 41.37501, 2.15152], ['Universitat', 'L1/L2', 41.38569, 2.16430],
  ['Catalunya', 'L1/L3/FGC', 41.38710, 2.16960], ['Urquinaona', 'L1/L4', 41.38809, 2.17331],
  ['Arc de Triomf', 'L1', 41.39211, 2.18091], ['Paral·lel', 'L2/L3', 41.37494, 2.16926],
  ['Sant Antoni', 'L2', 41.37979, 2.16327], ['Passeig de Gràcia', 'L2/L3/L4', 41.39000, 2.16700],
  ['Tetuan', 'L2', 41.39482, 2.17552], ['Monumental', 'L2', 41.40052, 2.17945],
  ['Sagrada Família', 'L2/L5', 41.40400, 2.17450], ['Drassanes', 'L3', 41.37667, 2.17577],
  ['Liceu', 'L3', 41.38140, 2.17307], ['Diagonal', 'L3/L5', 41.39520, 2.15940],
  ['Fontana', 'L3', 41.40206, 2.15298], ['Lesseps', 'L3', 41.40616, 2.15002],
  ['Vallcarca', 'L3', 41.41191, 2.14452], ['Sants Estació', 'L3/L5', 41.38070, 2.14070],
  ['Poble Sec', 'L3', 41.37498, 2.16057], ['Jaume I', 'L4', 41.38400, 2.17871],
  ['Barceloneta', 'L4', 41.38209, 2.18552], ['Ciutadella／Vila Olímpica', 'L4', 41.38782, 2.19358],
  ['Joanic', 'L4', 41.40627, 2.16319], ['Verdaguer', 'L4/L5', 41.39950, 2.16770],
  ['Girona', 'L4', 41.39502, 2.17096], ['Hospital Clínic', 'L5', 41.38816, 2.15054],
  ['Sant Pau／Dos de Maig', 'L5', 41.41073, 2.17598], ['Provença', 'FGC', 41.39287, 2.15798],
  ['Gràcia', 'FGC', 41.39976, 2.15215], ['Muntaner', 'FGC', 41.39867, 2.14281],
  ['Sant Gervasi', 'FGC', 41.40107, 2.14708],
];
const LINE_COLOR = { L1: '#E2231A', L2: '#9B2C98', L3: '#33A532', L4: '#F5B800', L5: '#0072BC', FGC: '#F58220', L9: '#F68B1F' };
const lineBadges = (lines) => lines.map((l) => {
  const key = l.replace(/\s.*/, '');
  return `<span class="line-badge" style="--lc:${LINE_COLOR[key] || 'var(--sub)'}">${esc(l)}</span>`;
}).join('');

/** 從地點的「交通」欄抓第一個建議：路線、站名、步行分鐘、轉乘提示 */
function parseTransit(text) {
  const first = String(text || '').split('\n')[0].split(/，或|或/)[0];
  const m = first.match(/((?:L\d+(?:\s*(?:Sud|Nord))?)(?:\s*\/\s*L\d+)*|FGC)\s+(.+?)\s*站/);
  if (!m) return first.trim() ? { raw: first.trim() } : null;
  const walk = first.match(/步行約\s*(\d+(?:[–-]\d+)?)\s*分/);
  const note = (first.split('站')[1] || '').match(/^(轉[^，]+)/);
  return {
    lines: m[1] === 'FGC' ? ['FGC'] : m[1].split('/').map((s) => s.trim()),
    station: m[2].replace(/\s*[|｜]\s*/g, '／'),
    walk: walk ? walk[1] : null,
    note: note ? note[1] : '',
  };
}
/** 沒寫交通的地點：用座標找最近的站（估算） */
function nearestStation(p) {
  const c = coordOf(p);
  if (!c || p['城市'] !== '巴塞隆納') return null;
  let best = null;
  BCN_STATIONS.forEach(([name, lines, lat, lng]) => {
    const d = distM(c, [lat, lng]);
    if (!best || d < best.d) best = { name, lines, d };
  });
  return best && { lines: best.lines.split('/'), station: best.name, walk: String(walkMin(best.d)), note: '', est: true };
}

/** 依行程自動整理「我們會用到的站」：新增、刪除、改日期都會跟著變 */
function usedStationsHtml(city) {
  const items = rows('行程').filter((r) => !truthy(r['已刪除']) && r['地點 ID'] && r['日期'])
    .map((r) => ({ r, p: placeById(r['地點 ID']) }))
    .filter(({ p }) => p && p['城市'] === city && p['類型'] !== '交通')
    .sort((a, b) => String(a.r['日期']).localeCompare(String(b.r['日期'])) || SLOTS.indexOf(a.r['時段']) - SLOTS.indexOf(b.r['時段']) || (Number(a.r['排序']) || 0) - (Number(b.r['排序']) || 0));
  if (!items.length) return '<div class="empty">這座城市的行程還沒有地點</div>';
  const seen = new Set();
  let lastDate = '';
  return items.map(({ r, p }) => {
    const key = r['日期'] + p.ID;
    if (seen.has(key)) return '';
    seen.add(key);
    const info = parseTransit(p['交通']) || nearestStation(p);
    let head = '';
    if (r['日期'] !== lastDate) { lastDate = r['日期']; head = `<div class="ts-date">${md(r['日期'])}（週${WD_NAME[weekdayOf(r['日期'])]}）</div>`; }
    let how;
    if (!info) how = '<span class="muted">交通待補</span>';
    else if (info.raw) how = `<span>${esc(info.raw)}</span>`;
    else how = `${lineBadges(info.lines)} <b>${esc(info.station)}</b>${info.walk ? `<span class="muted">・走 ${esc(info.walk)} 分${info.est ? '（估算）' : ''}</span>` : ''}${info.note ? `<span class="muted">・${esc(info.note)}</span>` : ''}`;
    return `${head}<button class="ts-row" data-act="place" data-v="${esc(p.ID)}"><span class="ts-place">${itemIcon(r, p)} ${esc(p['名稱'])}</span><span class="ts-how">${how}</span></button>`;
  }).join('');
}

function transitHtml(list) {
  const city = S.transitCity || (dayInfo(S.date || pickDefaultDate()).color === 'ams' ? '阿姆斯特丹' : '巴塞隆納');
  const mine = list.filter((r) => !r['城市'] || r['城市'] === city);
  const block = (b) => mine.filter((r) => (r['區塊'] || '須知') === b);
  const tipCard = (r) => {
    const text = String(r['內容'] || '');
    if (text.includes('→')) {
      return `<details class="card tool"><summary class="t">▸ ${esc(r['名稱'])}</summary>
        <ol class="steps">${text.split('→').map((s) => `<li>${esc(s.trim())}</li>`).join('')}</ol></details>`;
    }
    const lines = text.split(/[｜；]/).map((s) => s.trim()).filter(Boolean);
    return `<div class="card tool"><div class="tool-text"><div class="t">${esc(r['名稱'])}</div>
      ${lines.length > 1 ? `<ul class="stations">${lines.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : `<div class="d">${esc(text)}</div>`}</div></div>`;
  };
  const maps = block('地圖').filter((r) => r['連結']);
  const routes = block('路線');
  return `
    <div class="seg">${['巴塞隆納', '阿姆斯特丹'].map((c) => `<button class="${city === c ? 'on' : ''}" data-act="transit-city" data-v="${c}">${c}</button>`).join('')}</div>
    ${maps.length ? `<div class="map-btns">${maps.map((r) => `<a class="btn" href="${esc(r['連結'])}" target="_blank" rel="noopener">🗺 ${esc(r['名稱'])}</a>`).join('')}</div>` : ''}
    ${block('須知').map(tipCard).join('')}
    <div class="card ts-card"><div class="t">📍 我們會用到的站</div><div class="muted small">依行程自動整理，點一下看地點詳細</div>${usedStationsHtml(city)}</div>
    ${routes.length ? `<details class="card tool"><summary class="t">▸ 看全部路線（${routes.length}）</summary>
      ${routes.map((r) => `<div class="route"><div class="t">${esc(r['名稱'])}</div><ul class="stations">${String(r['內容'] || '').split('｜').map((s) => {
        const [k, ...rest] = s.trim().split('：');
        return rest.length ? `<li><b>${esc(k)}</b>　${esc(rest.join('：'))}</li>` : `<li>${esc(s.trim())}</li>`;
      }).join('')}</ul></div>`).join('')}</details>` : ''}`;
}

function toolsView() {
  const all = rows('工具箱');
  const groups = TOOL_ORDER.map((g) => [g, all.filter((r) => r['類別'] === g)]).filter(([, l]) => l.length);
  const html = groups.map(([g, list]) => {
    let body;
    if (g === '交通') {
      body = transitHtml(list);
    } else if (g === '翻譯') {
      const links = list.filter((r) => r['連結']).map((r) => `<a class="btn" href="${esc(r['連結'])}" target="_blank" rel="noopener">🌐 ${esc(r['名稱'])}</a>`).join('');
      body = `${links}<div class="muted small" style="margin:4px 2px">點一句放大，直接拿給店員看</div>
        <div class="card phrases">${PHRASES.map((p, i) => `<button class="phrase" data-act="phrase" data-v="${i}"><span class="zh">${esc(p[0])}</span><span class="es">${esc(p[1])}</span><span class="nl">${esc(p[2])}</span></button>`).join('')}</div>`;
    } else {
      body = list.map((r) => {
        const tel = g === '緊急' ? phoneOf(r['內容']) : null;
        const mine = g === '保險' && r['名稱'] === S.auth.user;
        const pending = /待/.test(String(r['內容'] || '')) || /待/.test(String(r['查證狀態'] || ''));
        // 內容用「｜」分段，一段一行，比較不擠（Q15）
        const lines = String(r['內容'] || '').split('｜').map((s) => `<div class="d${pending ? ' muted' : ''}">${esc(s.trim())}</div>`).join('');
        const acts = [
          tel ? `<a class="btn primary" href="tel:${esc(tel)}">📞 撥打 ${esc(tel)}</a>` : '',
          r['連結'] ? `<a class="btn" href="${esc(r['連結'])}" target="_blank" rel="noopener">🔗 打開官網</a>` : '',
        ].filter(Boolean).join('');
        return `<div class="card tool${mine ? ' mine' : ''}">
          <div class="tool-text"><div class="t">${esc(r['名稱'])}${mine ? '（你）' : ''}</div>${lines}</div>
          ${acts ? `<div class="tool-acts">${acts}</div>` : ''}
        </div>`;
      }).join('');
    }
    return `<div class="section-h"><h2>${TOOL_ICON[g] || ''} ${esc(g)}</h2></div><div class="list">${body}</div>`;
  }).join('');
  return html + '<p class="muted small" style="margin:18px 2px">工具箱只能在 Google 試算表改，避免被誤刪。</p>';
}
function phraseSheet(i) {
  const p = PHRASES[i];
  if (!p) return;
  openSheet(`
    <div class="phrase-big"><div class="lang">Español</div><div class="big-es">${esc(p[1])}</div>
    <div class="lang">Nederlands</div><div class="big-nl">${esc(p[2])}</div>
    <div class="muted">${esc(p[0])}</div></div>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">關閉</button></div></div>`);
}

function journalView() {
  return '<div class="soon"><div class="big">📝</div><p>日誌是第三批，旅途中開放。</p><p class="small">到時候想吐槽的、想說的都寫這裡。</p></div>';
}

/* ---------------- 底部面板 ---------------- */
function openSheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-backdrop" data-act="sheet-close"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  if (onMount) onMount(root);
}
function closeSheet() { $('#sheet-root').innerHTML = ''; }

function editItemSheet(id) {
  const r = rows('行程').find((x) => x.ID === id);
  if (!r) return;
  openSheet(`
    <h3>${esc(r['名稱'])}</h3>
    <div class="field"><label for="f-slot">時段</label><select id="f-slot">${SLOTS.map((s) => `<option${r['時段'] === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="field"><label for="f-time">時間</label><input id="f-time" type="time" value="${esc(r['時間'] || '')}"></div>
    <div class="field"><label for="f-note">備註</label><textarea id="f-note">${esc(r['備註'] || '')}</textarea></div>
    <div class="acts">
      <button class="btn danger" data-act="item-remove" data-v="${esc(id)}">移除</button>
      <div class="right"><button class="btn" data-act="sheet-close">取消</button><button class="btn primary" data-act="item-save" data-v="${esc(id)}">儲存</button></div>
    </div>`);
}
function editBookSheet(id) {
  const r = rows('預約').find((x) => x.ID === id);
  if (!r) return;
  openSheet(`
    <h3>${esc(r['項目'])}</h3>
    <div class="field"><label>小幫手（負責這筆預約、拿票的人）</label>
      <div class="who-pick">${['', ...USERS].map((u) => `<button type="button" class="chip${(r['票在誰手上'] || '') === u ? ' on' : ''}" data-act="pick" data-target="f-holder" data-v="${esc(u)}">${u ? who(u) : '還沒有'}</button>`).join('')}</div>
      <input type="hidden" id="f-holder" value="${esc(r['票在誰手上'] || '')}"></div>
    <div class="field"><label for="f-time">時間（會同步到行程）</label><input id="f-time" type="time" value="${esc(r['時間'] || '')}"></div>
    <div class="field"><label for="f-where">訂位資訊</label><input id="f-where" value="${esc(r['票券位置'] || '')}" placeholder="例：訂位代號 ABC123、慧慧的信箱主旨 Sagrada Familia"></div>
    <div class="field"><label for="f-note">備註</label><textarea id="f-note">${esc(r['備註'] || '')}</textarea></div>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">取消</button><button class="btn primary" data-act="book-save" data-v="${esc(id)}">儲存</button></div></div>`);
}
function todoSheet(id) {
  const r = id ? rows('待辦').find((x) => x.ID === id) : {};
  openSheet(`
    <h3>${id ? '編輯待辦' : '新增待辦'}</h3>
    <div class="field"><label for="f-title">要做什麼</label><input id="f-title" value="${esc(r['項目'] || '')}" placeholder="例：買 eSIM"></div>
    <div class="field"><label for="f-desc">說明</label><textarea id="f-desc">${esc(r['說明'] || '')}</textarea></div>
    <div class="field"><label>負責人</label>
      <div class="who-pick">${['', ...USERS].map((u) => `<button type="button" class="chip${(id ? (r['負責人'] || '') : S.auth.user) === u ? ' on' : ''}" data-act="pick" data-target="f-owner" data-v="${esc(u)}">${u ? who(u) : '大家'}</button>`).join('')}</div>
      <input type="hidden" id="f-owner" value="${esc(id ? (r['負責人'] || '') : S.auth.user)}"></div>
    <div class="acts">
      ${id ? `<button class="btn danger" data-act="todo-remove" data-v="${esc(id)}">移除</button>` : ''}
      <div class="right"><button class="btn" data-act="sheet-close">取消</button><button class="btn primary" data-act="todo-save" data-v="${esc(id || '')}">儲存</button></div>
    </div>`, () => { const t = $('#f-title'); if (t && !id) t.focus(); });
}
/** 待辦卡片上直接點負責人就能換人 */
function ownerSheet(id) {
  const r = rows('待辦').find((x) => x.ID === id);
  if (!r) return;
  openSheet(`
    <h3>誰負責「${esc(r['項目'])}」？</h3>
    <div class="who-grid">${['', ...USERS].map((u) => `<button class="${(r['負責人'] || '') === u ? 'on' : ''}" data-act="owner-set" data-id="${esc(id)}" data-v="${esc(u)}">${u ? who(u) : '大家'}</button>`).join('')}</div>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">取消</button></div></div>`);
}
/** 地點詳細（行程的「看更多」、附近推薦點名稱）（Q13） */
function placeSheet(id, slot) {
  const p = placeById(id);
  if (!p) return;
  const now = madridNow();
  const st = openState(p, now.wd, now.min, true);
  const used = rows('行程').some((r) => r['地點 ID'] === id && !truthy(r['已刪除']));
  const canAdd = slot && !used;
  openSheet(`
    <h3>${TYPE_ICON[p['類型']] || '📍'} ${esc(p['名稱'])}</h3>
    <div class="badges">
      ${isClosed(p) ? '<span class="pill bad">⚠ 暫時關閉</span>' : ''}
      ${Number(p['評分']) ? `<span class="pill mute num">★ ${Number(p['評分']).toFixed(1)}</span>` : ''}
      ${st.k !== 'unknown' ? `<span class="pill ${st.k}">當地現在：${esc(st.t)}</span>` : ''}
      ${priceText(p) ? `<span class="pill mute num">${esc(priceText(p))}</span>` : ''}
      <span class="pill mute">${esc(p['類型'])}・${esc(p['區域'] || '')}</span>
    </div>
    <div class="list small">
      ${p['特色'] ? `<div>✨ ${esc(p['特色'])}</div>` : ''}
      ${p['營業提醒'] ? `<div class="hours">🕘 ${esc(p['營業提醒'])}</div>` : ''}
      ${p['交通'] ? `<div class="hours">🚇 ${esc(p['交通'])}</div>` : ''}
      ${p['地址'] ? `<div>📍 ${esc(p['地址'])}</div>` : ''}
      ${p['查證狀態'] ? `<div class="muted">${esc(p['查證狀態'])}</div>` : ''}
      ${used ? '<div class="muted">已經排進行程了</div>' : ''}
    </div>
    <div class="acts">
      <a class="btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener">🗺 Google 地圖</a>
      ${p['官網'] ? `<a class="btn" href="${esc(p['官網'])}" target="_blank" rel="noopener">🌐 官網</a>` : ''}
      <div class="right">
        <button class="btn" data-act="sheet-close">關閉</button>
        ${canAdd ? `<button class="btn primary" data-act="add-reco" data-v="${esc(p.ID)}" data-slot="${slot}">＋ 加進${slot}</button>` : ''}
      </div>
    </div>`);
}

/** 手動新增行程（Q09）：可以只寫名稱，也可以從口袋名單挑地點 */
function itemAddSheet() {
  const info = dayInfo(S.date);
  const cities = [info.code === 'move' ? null : CITY_NAME[info.code], CITY_NAME[info.from], CITY_NAME[info.to]].filter(Boolean);
  const places = rows('地點').filter((p) => p['類型'] !== '交通' && (!cities.length || cities.includes(p['城市'])))
    .sort((a, b) => String(a['類型']).localeCompare(String(b['類型'])) || String(a['名稱']).localeCompare(String(b['名稱'])));
  openSheet(`
    <h3>新增行程｜${md(S.date)}（週${WD_NAME[weekdayOf(S.date)]}）</h3>
    <div class="field"><label>時段</label>
      <div class="who-pick">${SLOTS.map((s, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-act="pick" data-target="f-slot" data-v="${s}">${s}</button>`).join('')}</div>
      <input type="hidden" id="f-slot" value="${SLOTS[0]}"></div>
    <div class="field"><label for="f-time">時間（可不填）</label><input id="f-time" type="time"></div>
    <div class="field"><label for="f-place">從口袋名單挑（可不選）</label><select id="f-place"><option value="">不指定地點</option>${places.map((p) => `<option value="${esc(p.ID)}">${TYPE_ICON[p['類型']] || ''} ${esc(p['名稱'])}</option>`).join('')}</select></div>
    <div class="field"><label for="f-name">名稱</label><input id="f-name" placeholder="例：超市補貨、河邊散步（選了地點可以不填）"></div>
    <div class="field"><label for="f-note">備註</label><textarea id="f-note"></textarea></div>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">取消</button><button class="btn primary" data-act="item-add-save">新增</button></div></div>`);
}

function settingsSheet() {
  openSheet(`
    <h3>設定</h3>
    <div class="muted small">目前身分：${esc(who(S.auth.user))}${S.auth.demo ? '（示範資料，改了不會存）' : ''}・app 版本 ${APP_VERSION}</div>
    <div class="muted small">上次同步：${S.syncedAt ? new Date(S.syncedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '還沒'}・送出中 ${S.pending || 0} 筆${S.lastError ? `<br>最近的錯誤：${esc(S.lastError)}` : ''}</div>
    <button class="btn" data-act="refresh">🔄 重新整理資料</button>
    <button class="btn" data-act="logout">換人／重新登入</button>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">關閉</button></div></div>`);
}

/* ---------------- 提示 ---------------- */
let toastTimer;
function toast(msg, undo, label = '復原', ms) {
  const root = $('#toast-root');
  root.innerHTML = `<div class="toast"><span>${esc(msg)}</span>${undo ? `<button data-act="undo">${esc(label)}</button>` : ''}</div>`;
  toast.undo = undo || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; toast.undo = null; }, ms || (undo ? 5000 : 2600));
}

/* ---------------- 瓷磚紋（巴塞：高第碎瓷磚；阿姆：台夫特藍瓷） ---------------- */
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function tilePalette() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? { tren: ['#B8602F', '#C99A35', '#5F7E3A', '#3E66AD', '#3A3428', '#A86A3E'], grout: '#141B2D', fill: '#1E2740', ink: '#7FA6E8', dgrout: '#141B2D' }
    : { tren: ['#C8642E', '#E3B23C', '#6B8E3D', '#1F4E9C', '#F1E3C8', '#DB8A52'], grout: '#FAF7F2', fill: '#F6F3EA', ink: '#1F4E9C', dgrout: '#DDE3EE' };
}
function drawTrencadis(ctx, w, h, p) {
  const r = rng(7), cell = 13, cols = Math.ceil(w / cell) + 1, rowsN = Math.ceil(h / cell) + 1, pts = [];
  ctx.fillStyle = p.grout; ctx.fillRect(0, 0, w, h);
  for (let y = 0; y <= rowsN; y++) { pts[y] = []; for (let x = 0; x <= cols; x++) pts[y][x] = [x * cell + (r() - 0.5) * 8, y * cell + (r() - 0.5) * 8]; }
  ctx.lineWidth = 2; ctx.strokeStyle = p.grout; ctx.lineJoin = 'round';
  const poly = (q) => { ctx.beginPath(); q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fillStyle = p.tren[Math.floor(r() * p.tren.length)]; ctx.fill(); ctx.stroke(); };
  for (let y = 0; y < rowsN; y++) for (let x = 0; x < cols; x++) {
    const a = pts[y][x], b = pts[y][x + 1], c = pts[y + 1][x + 1], d = pts[y + 1][x];
    if (r() < 0.45) { poly([a, b, c]); poly([a, c, d]); } else poly([a, b, c, d]);
  }
}
function drawDelft(ctx, w, h, p) {
  const s = h;
  ctx.fillStyle = p.dgrout; ctx.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += s) {
    ctx.fillStyle = p.fill; ctx.fillRect(x + 1, 1, s - 2, s - 2);
    const cx = x + s / 2, cy = s / 2;
    ctx.fillStyle = p.ink;
    for (let k = 0; k < 4; k++) { ctx.save(); ctx.translate(cx, cy); ctx.rotate((k * Math.PI) / 2 + Math.PI / 4); ctx.beginPath(); ctx.ellipse(0, -s * 0.16, s * 0.07, s * 0.15, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.06, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.55;
    [[x + 1, 1, 0], [x + s - 1, 1, 0.5], [x + s - 1, s - 1, 1], [x + 1, s - 1, 1.5]].forEach(([qx, qy, st]) => { ctx.beginPath(); ctx.moveTo(qx, qy); ctx.arc(qx, qy, s * 0.2, st * Math.PI, (st + 0.5) * Math.PI); ctx.closePath(); ctx.fill(); });
    ctx.globalAlpha = 1;
  }
}
function paintTiles() {
  const p = tilePalette();
  document.querySelectorAll('canvas[data-tile]').forEach((cv) => {
    const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cv.dataset.tile === 'ams') drawDelft(ctx, w, h, p); else drawTrencadis(ctx, w, h, p);
  });
}

/* ---------------- 事件 ---------------- */
async function loadData() {
  // 已經有快取：先顯示快取，背景同步（同步期間的編輯不會被蓋掉）
  if (S.data && !S.auth.demo) { S.syncing = false; render(); render.spin(true); syncData(); return; }
  S.error = '';
  render();
  try {
    S.data = await fetchAll();
    S.syncedAt = Date.now();
    store.set('cache', { at: S.syncedAt, demo: !!S.auth.demo, data: S.data });
  } catch (err) {
    S.error = '讀不到資料：' + err.message;
  }
  render();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  S.touched = true;
  const act = el.dataset.act, v = el.dataset.v;
  if (act === 'sheet-close') {
    if (e.target === el || el.tagName === 'BUTTON') { closeSheet(); if (S.renderAfterSheet) { S.renderAfterSheet = false; render(); } }
    return;
  }

  switch (act) {
    case 'login-user': S.loginUser = v; render(); break;
    case 'login': {
      const key = $('#pass').value.trim();
      if (!S.loginUser) { S.loginError = '先選你是誰'; render(); break; }
      if (!key) { S.loginError = '通行碼還沒填'; render(); break; }
      S.loginError = '';
      S.auth = { user: S.loginUser, key };
      try {
        S.data = await fetchAll();
        store.set('auth', S.auth);
        render();
      } catch (err) {
        S.auth = null; S.loginError = err.message; render();
      }
      break;
    }
    case 'demo': S.auth = { user: S.loginUser || '慧慧', key: null, demo: true }; loadData(); break;
    case 'logout': store.del('auth'); store.del('cache'); S.auth = null; S.data = null; closeSheet(); render(); break;
    case 'retry': loadData(); break;
    case 'refresh':
      closeSheet();
      if (S.auth.demo) { toast('示範資料不用更新'); break; }
      render.spin(true);
      syncData({ toast: true });
      break;
    case 'settings': settingsSheet(); break;
    case 'tab': S.tab = v; store.set('tab', v); closeSheet(); render(); window.scrollTo(0, 0); break;
    case 'date': S.date = v; render(); break;
    case 'reco-more': S.recoOpen[v] = !S.recoOpen[v]; render(); break;
    case 'add-reco': {
      closeSheet();
      const p = placeById(v);
      const slot = el.dataset.slot;
      const n = rows('行程').filter((r) => r['日期'] === S.date).length + 1;
      addRow('行程', { 日期: S.date, 時段: slot, '地點 ID': p.ID, 名稱: p['名稱'], 排序: n }, `已加進 ${md(S.date)} ${slot}`);
      break;
    }
    case 'edit-item': editItemSheet(v); break;
    case 'place': placeSheet(v, el.dataset.slot); break;
    case 'add-item': itemAddSheet(); break;
    case 'item-add-save': {
      const pid = $('#f-place').value;
      const p = pid ? placeById(pid) : null;
      const name = $('#f-name').value.trim() || (p ? p['名稱'] : '');
      if (!name) { $('#f-name').focus(); break; }
      const slot = $('#f-slot').value;
      const n = rows('行程').filter((r) => r['日期'] === S.date).length + 1;
      closeSheet();
      addRow('行程', { 日期: S.date, 時段: slot, 時間: $('#f-time').value, '地點 ID': pid, 名稱: name, 備註: $('#f-note').value.trim(), 排序: n }, `已加進 ${md(S.date)} ${slot}`);
      break;
    }
    case 'item-save': {
      const time = $('#f-time').value;
      updateRow('行程', v, { 時段: $('#f-slot').value, 時間: time, 備註: $('#f-note').value }, '存好了');
      mirrorTime('行程', v, time);
      closeSheet();
      break;
    }
    case 'item-remove': closeSheet(); updateRow('行程', v, { 已刪除: true }, '已移除', { 已刪除: false }); break;
    case 'heart': toggleHeart(v); break;
    case 'pf-city': S.pf.city = v; S.pf.region = '全部'; render(); break;
    case 'pf-type': S.pf.type = v; render(); break;
    case 'pf-region': S.pf.region = v; render(); break;
    case 'pf-price': S.pf.price = v; render(); break;
    case 'transit-city': S.transitCity = v; render(); break;
    case 'visited': {
      const p = placeById(v);
      const nv = !truthy(p['已去過']);
      updateRow('地點', v, { 已去過: nv }, nv ? '打卡完成 ✅' : '取消打卡');
      break;
    }
    case 'book-status': {
      const r = rows('預約').find((x) => x.ID === v);
      const s = el.dataset.s;
      if (!r || r['狀態'] === s) break;
      updateRow('預約', v, { 狀態: s }, s === '已取消' ? '已取消這筆預約' : `改成「${s}」`, { 狀態: r['狀態'] });
      break;
    }
    case 'edit-book': editBookSheet(v); break;
    case 'book-filter': S.bookFilter = v; render(); break;
    case 'pick': {
      const inp = document.getElementById(el.dataset.target);
      if (inp) inp.value = v;
      el.parentElement.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === el));
      break;
    }
    case 'owner': ownerSheet(v); break;
    case 'owner-set': {
      closeSheet();
      updateRow('待辦', el.dataset.id, { 負責人: v }, v ? `改由 ${v} 負責` : '改成大家一起');
      break;
    }
    case 'book-save': {
      const time = $('#f-time').value;
      updateRow('預約', v, { 時間: time, 票在誰手上: $('#f-holder').value, 票券位置: $('#f-where').value, 備註: $('#f-note').value }, '存好了');
      mirrorTime('預約', v, time);
      closeSheet();
      break;
    }
    case 'prep-tab': S.prepTab = v; render(); break;
    case 'only-mine': S.onlyMine = !S.onlyMine; render(); break;
    case 'todo-done': {
      const r = rows('待辦').find((x) => x.ID === v);
      const nv = !truthy(r['完成']);
      updateRow('待辦', v, { 完成: nv }, nv ? '做完了，讚 👍' : '改回還沒做');
      const left = rows('待辦').filter((x) => !truthy(x['已刪除']) && !truthy(x['完成'])).length;
      if (nv && left === 0) toast('全部搞定，安心出發 ✈️');
      break;
    }
    case 'add-todo': todoSheet(null); break;
    case 'edit-todo': todoSheet(v); break;
    case 'todo-save': {
      const fields = { 項目: $('#f-title').value.trim(), 說明: $('#f-desc').value.trim(), 負責人: $('#f-owner').value };
      if (!fields['項目']) { $('#f-title').focus(); break; }
      closeSheet();
      if (v) updateRow('待辦', v, fields, '存好了');
      else addRow('待辦', fields, '新增好了');
      break;
    }
    case 'todo-remove': closeSheet(); updateRow('待辦', v, { 已刪除: true }, '已移除', { 已刪除: false }); break;
    case 'shop-filter': S.shopFilter = v; render(); break;
    case 'shop-bought': {
      const r = rows('購物').find((x) => x.ID === v);
      const nv = !truthy(r['已買']);
      updateRow('購物', v, { 已買: nv }, nv ? '買到了 🛍' : '改回還沒買');
      break;
    }
    case 'shop-detail': shopDetailSheet(v); break;
    case 'shop-remove': closeSheet(); updateRow('購物', v, { 已刪除: true }, '已移除', { 已刪除: false }); break;
    case 'add-shop': shopAddSheet(); break;
    case 'shop-save': {
      const fields = {
        商品: $('#f-name').value.trim(), 哪裡買: $('#f-where').value.trim(), 參考價: $('#f-price').value.trim(),
        '地點 ID': $('#f-place').value, 順路日期: $('#f-day').value, 說明: $('#f-desc').value.trim(),
      };
      if (!fields['商品']) { $('#f-name').focus(); break; }
      closeSheet();
      addRow('購物', fields, '新增好了，記得按 ❤️');
      break;
    }
    case 'phrase': phraseSheet(Number(v)); break;
    case 'undo': if (toast.undo) { const u = toast.undo; toast.undo = null; $('#toast-root').innerHTML = ''; u(); } break;
    default: break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'pq') {
    S.pf.q = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const inp = $('#pq');
    if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'pass') { const b = $('[data-act="login"]'); if (b) b.click(); }
  if (e.key === 'Escape') closeSheet();
});
/**
 * 手機（尤其加到主畫面的）常會一直用快取的舊版 app.js。
 * 每次打開或切回來就檢查 version.json，版本不同就帶新參數重新載入一次。
 */
async function checkVersion() {
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const { v } = await r.json();
    if (v && v !== APP_VERSION) {
      const go = () => location.replace(location.pathname + '?v=' + encodeURIComponent(v));
      // 使用者已經開始操作（或還有修改在送）就不要突然重新載入，改用提示讓她自己按
      if (S.touched || (S.pending || 0) > 0) { toast('有新版本了', go, '更新', 15000); return; }
      const tried = sessionStorage.getItem('reloaded-for');
      if (tried === v) return;
      sessionStorage.setItem('reloaded-for', v);
      go();
    }
  } catch (e) { /* 沒網路就算了 */ }
}

// 自動同步：回到 app 時、以及開著的時候每 45 秒抓一次別人改的東西
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  checkVersion();
  if (S.auth && S.data) syncData();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && S.auth && S.data && !$('#sheet-root').innerHTML) syncData();
}, 45000);

// 下拉重新整理：在頁面最上方往下拉超過 80px 放開
(function pullToRefresh() {
  let y0 = null, pulled = 0;
  const ind = () => $('#ptr');
  document.addEventListener('touchstart', (e) => {
    y0 = (window.scrollY <= 0 && !$('#sheet-root').innerHTML && S.data) ? e.touches[0].clientY : null;
    pulled = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    pulled = e.touches[0].clientY - y0;
    const el = ind();
    if (el) { el.classList.toggle('show', pulled > 30); el.classList.toggle('ready', pulled > 80); }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    const el = ind();
    if (el) el.classList.remove('show', 'ready');
    if (y0 != null && pulled > 80) { render.spin(true); syncData({ toast: true }); }
    y0 = null; pulled = 0;
  });
})();
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(paintTiles, 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintTiles);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(paintTiles);

/* ---------------- 啟動 ---------------- */
(function start() {
  checkVersion();
  if (S.auth && OLD_NAMES[S.auth.user]) { S.auth.user = OLD_NAMES[S.auth.user]; store.set('auth', S.auth); }
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (isLocal && new URLSearchParams(location.search).has('demo')) S.auth = { user: '慧慧', key: null, demo: true };
  if (!S.auth) { render(); return; }
  const cache = store.get('cache');
  if (cache && cache.data && !!cache.demo === !!S.auth.demo) { S.data = cache.data; render(); }
  loadData();
})();
