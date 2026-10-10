/* 荷西行 app：第一批（行程、地點、預約、準備→待辦） */
'use strict';

const API_URL = 'https://script.google.com/macros/s/AKfycbxy2p0Fgyqzs5S4ReD2-IfsrA9HxptMY5YoFt5P9kbKifGf7k2R5FTSLOEteszik4gDrA/exec';
const USERS = ['妹妹', '簡', '十一', '朱'];
const SLOTS = ['早上', '中午', '下午', '晚上'];
const SLOT_MIN = { 早上: 600, 中午: 780, 下午: 960, 晚上: 1200 };
const TYPES = ['景點', '餐廳', '酒吧', '甜點', '咖啡廳', '麵包店', '購物'];
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
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({}, body, { key: S.auth.key, user: S.auth.user })),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '儲存失敗');
  return j;
}

const rows = (sheet) => (S.data && S.data[sheet]) || [];
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
  } catch (err) {
    Object.assign(row, before);
    render();
    toast('沒存到：' + err.message);
  }
}
async function addRow(sheet, fields, okMsg) {
  const temp = Object.assign({ ID: 'tmp-' + Date.now() }, fields);
  if (sheet === '待辦') Object.assign(temp, { 完成: false, 已刪除: false, 建立者: S.auth.user });
  if (sheet === '行程') Object.assign(temp, { 已刪除: false, 新增者: S.auth.user, 來源: 'app 新增' });
  S.data[sheet].push(temp);
  render();
  if (okMsg) toast(okMsg);
  try {
    const j = await post({ action: 'add', sheet, fields });
    if (j.row) Object.assign(temp, j.row);
    else if (S.auth.demo) temp.ID = 'demo-' + Date.now();
    render();
  } catch (err) {
    S.data[sheet] = S.data[sheet].filter((r) => r !== temp);
    render();
    toast('沒存到：' + err.message);
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
  } catch (err) {
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

  app.innerHTML = `
    <header class="topbar">
      <h1>瘋女紙荷西行${S.auth.demo ? '<span class="demo-tag">示範資料</span>' : ''}</h1>
      <button class="who" data-act="settings" aria-label="設定">👤 ${esc(S.auth.user)}</button>
    </header>
    <main>${body}</main>
    ${S.tab === 'prep' && S.prepTab === 'todo' ? '<button class="fab" data-act="add-todo">＋ 新增待辦</button>' : ''}
    <nav class="tabbar">
      ${[['trip', '📅', '行程'], ['places', '📍', '地點'], ['book', '🎫', '預約'], ['prep', '🧳', '準備'], ['journal', '📝', '日誌']]
        .map(([k, ic, l]) => `<button class="tab${S.tab === k ? ' on' : ''}" data-act="tab" data-v="${k}"><span class="ic">${ic}</span>${l}</button>`).join('')}
    </nav>`;
  paintTiles();
  if (S.tab === 'trip') {
    const chip = $('.date-chip.on');
    if (chip && !render.scrolled) { chip.scrollIntoView({ inline: 'center', block: 'nearest' }); render.scrolled = true; }
    if (info.wxCity) loadWeather(info.wxCity);
  }
}

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
        <div class="who-grid">${USERS.map((u) => `<button class="${pick === u ? 'on' : ''}" data-act="login-user" data-v="${esc(u)}">${esc(u)}</button>`).join('')}</div>
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
  if (info.code === 'bcn' || info.code === 'ams') band = `<canvas data-tile="${info.code}"></canvas>`;
  else band = `<div class="move-band" style="--from:var(--${info.from || info.color});--to:var(--${info.to || info.color})"></div>`;

  const items = rows('行程').filter((r) => r['日期'] === S.date && !truthy(r['已刪除']));
  const usedIds = new Set(items.map((r) => r['地點 ID']).filter(Boolean));
  const bySlot = {};
  SLOTS.forEach((s) => { bySlot[s] = items.filter((r) => r['時段'] === s).sort((a, b) => (Number(a['排序']) || 0) - (Number(b['排序']) || 0) || String(a['時間']).localeCompare(String(b['時間']))); });

  const flights = items.filter((r) => r['類別'] === '航班');
  const infoPills = [];
  if (d['住宿']) infoPills.push(`<span class="pill mute">🏠 ${esc(d['住宿'])}</span>`);
  flights.forEach((f) => infoPills.push(`<span class="pill city">✈️ ${esc(f['時間'] || '')} ${esc(f['名稱'])}</span>`));

  const slotsHtml = SLOTS.map((slot) => {
    const list = bySlot[slot];
    let html = list.map((r) => itemHtml(r)).join('');
    if (!list.length) html += '<div class="free">今天放飛 🕊</div>';
    html += recoHtml(slot, bySlot, usedIds, info);
    return `<section class="slot"><div class="slot-t">${slot}</div><div class="slot-c">${html}</div></section>`;
  }).join('');

  const buys = rows('購物').filter((r) => r['順路日期'] === S.date && !truthy(r['已刪除']))
    .sort((a, b) => hearts(b).length - hearts(a).length);
  const buyHtml = buys.length ? `
    <div class="section-h"><h2>🛍 今天順路可買</h2><span class="muted small">依 ❤️ 排序</span></div>
    <div class="card">${buys.map((b) => buyRowHtml(b)).join('')}</div>` : '';

  return `
    <div class="dates"><div class="chips">${dateChips}</div></div>
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
  if (r['來源'] === 'app 新增' && r['新增者']) badges.push(`<span class="pill mute">${esc(r['新增者'])} 加的</span>`);
  const icon = r['類別'] === '航班' ? '✈️' : '📌';
  return `<div class="card item">
    <button class="item-main" data-act="edit-item" data-v="${esc(r.ID)}">
      <span class="item-name">${r['時間'] ? `<span class="time">${esc(r['時間'])}</span>` : ''}<span>${icon} ${esc(r['名稱'])}</span></span>
      ${badges.length ? `<span class="badges">${badges.join('')}</span>` : ''}
      ${r['備註'] ? `<span class="item-note">${esc(r['備註'])}</span>` : ''}
    </button>
    ${p ? `<a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>` : ''}
  </div>`;
}
function timeToMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function anchorsFor(slot, bySlot, info) {
  const idx = SLOTS.indexOf(slot);
  const order = [idx, idx - 1, idx + 1, idx - 2, idx + 2, idx - 3, idx + 3].filter((i) => i >= 0 && i < 4);
  for (const i of order) {
    const pts = bySlot[SLOTS[i]].map((r) => placeById(r['地點 ID'])).filter((p) => p && !['交通'].includes(p['類型'])).map(coordOf).filter(Boolean);
    if (pts.length) return pts;
  }
  if (info.code === 'bcn') {
    const home = rows('地點').find((p) => p['類型'] === '住宿' && p['城市'] === '巴塞隆納');
    if (home && coordOf(home)) return [coordOf(home)];
  }
  return [];
}

function recoHtml(slot, bySlot, usedIds, info) {
  const anchors = anchorsFor(slot, bySlot, info);
  if (!anchors.length) {
    return info.code === 'ams' ? '<div class="reco"><div class="reco-h">附近還沒有口袋名單，敲妹妹 👀</div></div>' : '';
  }
  const wd = weekdayOf(S.date);
  const min = SLOT_MIN[slot];
  const list = [];
  rows('地點').forEach((p) => {
    if (!RECO_TYPES.includes(p['類型']) || usedIds.has(p.ID)) return;
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
        <div style="min-width:0"><div class="nm">${esc(p['名稱'])}</div>
          <div class="meta num">${esc(p['類型'])}・步行 ${w} 分${Number(p['評分']) ? `・${Number(p['評分']).toFixed(1)}★` : ''}${truthy(p['已去過']) ? '・去過了' : ''}${st.k === 'warn' ? '・快打烊' : ''}</div></div>
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
  const list = all.filter((p) => (f.type === '全部' || p['類型'] === f.type) && (f.region === '全部' || p['區域'] === f.region)
    && (!q || [p['名稱'], p['特色'], p['區域'], p['地址']].join(' ').toLowerCase().includes(q)));
  list.sort((a, b) => Number(truthy(a['已去過'])) - Number(truthy(b['已去過'])) || (Number(b['評分']) || 0) - (Number(a['評分']) || 0));
  const counts = {};
  all.forEach((p) => { counts[p['類型']] = (counts[p['類型']] || 0) + 1; });

  return `
    <div class="filters">
      <div class="seg">${['巴塞隆納', '阿姆斯特丹'].map((c) => `<button class="${f.city === c ? 'on' : ''}" data-act="pf-city" data-v="${c}">${c}</button>`).join('')}</div>
      <input class="search" id="pq" type="search" placeholder="搜尋店名、特色、區域" value="${esc(f.q)}">
      <div class="chips">${['全部', ...TYPES].filter((t) => t === '全部' || counts[t]).map((t) => `<button class="chip${f.type === t ? ' on' : ''}" data-act="pf-type" data-v="${t}">${t}${t !== '全部' ? ` ${counts[t]}` : ''}</button>`).join('')}</div>
      ${regions.length > 2 ? `<div class="chips">${regions.map((r) => `<button class="chip${f.region === r ? ' on' : ''}" data-act="pf-region" data-v="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="muted small" style="margin:2px 2px 10px">當地現在 ${String(Math.floor(now.min / 60)).padStart(2, '0')}:${String(now.min % 60).padStart(2, '0')}（週${WD_NAME[now.wd]}），燈號照這個時間算</div>
    <div class="list">${list.length ? list.map((p) => placeHtml(p, now)).join('') : '<div class="empty">沒有符合的地點</div>'}</div>`;
}
function placeHtml(p, now) {
  const st = openState(p, now.wd, now.min, true);
  const visited = truthy(p['已去過']);
  return `<article class="card place${visited ? ' visited' : ''}">
    <div class="place-top">
      <button class="check${visited ? ' on' : ''}" data-act="visited" data-v="${esc(p.ID)}" aria-label="已去過">${visited ? '✓' : ''}</button>
      <div class="nm">${esc(p['名稱'])}<small>${esc(p['類型'])}・${esc(p['區域'] || '')}</small></div>
      <a class="icon-btn" href="${esc(mapsUrl(p))}" target="_blank" rel="noopener" aria-label="開 Google 地圖">🗺</a>
    </div>
    <div class="badges">
      ${Number(p['評分']) ? `<span class="pill mute num">★ ${Number(p['評分']).toFixed(1)}</span>` : ''}
      ${st.k !== 'unknown' ? `<span class="pill ${st.k}">${esc(st.t)}</span>` : '<span class="pill mute">營業時間待查</span>'}
      ${visited ? '<span class="pill ok">打卡完成 ✅</span>' : ''}
    </div>
    ${p['特色'] ? `<div class="feat">${esc(p['特色'])}</div>` : ''}
    <details><summary>營業時間・交通 ▾</summary>
      ${p['營業提醒'] ? `<div class="hours">${esc(p['營業提醒'])}</div>` : ''}
      ${p['交通'] ? `<div class="hours" style="margin-top:6px">🚇 ${esc(p['交通'])}</div>` : ''}
      ${p['地址'] ? `<div style="margin-top:6px">📍 ${esc(p['地址'])}</div>` : ''}
      ${p['查證狀態'] ? `<div style="margin-top:6px">${esc(p['查證狀態'])}</div>` : ''}
    </details>
  </article>`;
}

/* ----- 預約 ----- */
function bookView() {
  const list = rows('預約').slice().sort((a, b) => String(a['日期']).localeCompare(String(b['日期'])) || String(a['時間'] || '99').localeCompare(String(b['時間'] || '99')));
  const count = (s) => list.filter((r) => r['狀態'] === s).length;
  let lastDate = '';
  const html = list.map((r) => {
    let head = '';
    if (r['日期'] !== lastDate) { lastDate = r['日期']; head = `<div class="book-date num">${md(r['日期'])}（週${WD_NAME[weekdayOf(r['日期'])]}）</div>`; }
    const si = STATUS.indexOf(r['狀態']);
    return `${head}<article class="card book${r['狀態'] === '已取消' ? ' cancelled' : ''}">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div class="bk-name">${r['時間'] ? `<span class="num" style="color:var(--city)">${esc(r['時間'])}</span> ` : ''}${esc(r['項目'])}</div>
          <div class="bk-meta">${r['票在誰手上'] ? `🎟 ${esc(r['票在誰手上'])}` : '🎟 還沒指定誰拿票'}${r['票券位置'] ? `・${esc(r['票券位置'])}` : ''}</div>
          ${r['備註'] ? `<div class="bk-meta">${esc(r['備註'])}</div>` : ''}
          ${r['更新者'] ? `<div class="bk-meta">最後由 ${esc(r['更新者'])} 更新</div>` : ''}
        </div>
        <button class="icon-btn" data-act="edit-book" data-v="${esc(r.ID)}" aria-label="編輯">✏️</button>
      </div>
      <div class="status-seg">${STATUS.map((s, i) => `<button class="s${i}${si === i ? ' on' : ''}" data-act="book-status" data-v="${esc(r.ID)}" data-s="${s}">${s}</button>`).join('')}</div>
    </article>`;
  }).join('');
  return `
    <div class="section-h"><h2>預約</h2></div>
    <div class="summary-strip">
      <span class="pill bad">未訂 ${count('未訂')}</span><span class="pill ok">已訂 ${count('已訂')}</span>${count('已取消') ? `<span class="pill mute">已取消 ${count('已取消')}</span>` : ''}
    </div>
    ${html || '<div class="empty">還沒有預約</div>'}`;
}

/* ----- 準備 ----- */
function prepView() {
  const seg = `<div class="seg" style="margin-top:6px">${[['todo', '待辦'], ['shop', '購物'], ['tools', '工具箱']].map(([k, l]) => `<button class="${S.prepTab === k ? 'on' : ''}" data-act="prep-tab" data-v="${k}">${l}</button>`).join('')}</div>`;
  if (S.prepTab !== 'todo') {
    return seg + `<div class="soon"><div class="big">🛠</div><p>${S.prepTab === 'shop' ? '購物清單' : '工具箱'}是第二批，出發前上線。</p><p class="small">現在可以先到 Google 試算表看。</p></div>`;
  }
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
        ${r['負責人'] ? `<span class="owner${r['負責人'] === S.auth.user ? ' me' : ''}">${esc(r['負責人'])}</span>` : ''}
      </div>`;
    }).join('') || '<div class="empty">沒有待辦</div>'}</div>`;
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
    <div class="field"><label for="f-holder">票在誰手上</label><select id="f-holder"><option value="">還沒指定</option>${USERS.map((u) => `<option${r['票在誰手上'] === u ? ' selected' : ''}>${u}</option>`).join('')}</select></div>
    <div class="field"><label for="f-where">票券位置</label><input id="f-where" value="${esc(r['票券位置'] || '')}" placeholder="例：朱的信箱，主旨 Sagrada Familia"></div>
    <div class="field"><label for="f-note">備註</label><textarea id="f-note">${esc(r['備註'] || '')}</textarea></div>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">取消</button><button class="btn primary" data-act="book-save" data-v="${esc(id)}">儲存</button></div></div>`);
}
function todoSheet(id) {
  const r = id ? rows('待辦').find((x) => x.ID === id) : {};
  openSheet(`
    <h3>${id ? '編輯待辦' : '新增待辦'}</h3>
    <div class="field"><label for="f-title">要做什麼</label><input id="f-title" value="${esc(r['項目'] || '')}" placeholder="例：買 eSIM"></div>
    <div class="field"><label for="f-desc">說明</label><textarea id="f-desc">${esc(r['說明'] || '')}</textarea></div>
    <div class="field"><label for="f-owner">負責人</label><select id="f-owner"><option value="">大家</option>${USERS.map((u) => `<option${(r['負責人'] || (id ? '' : S.auth.user)) === u ? ' selected' : ''}>${u}</option>`).join('')}</select></div>
    <div class="acts">
      ${id ? `<button class="btn danger" data-act="todo-remove" data-v="${esc(id)}">移除</button>` : ''}
      <div class="right"><button class="btn" data-act="sheet-close">取消</button><button class="btn primary" data-act="todo-save" data-v="${esc(id || '')}">儲存</button></div>
    </div>`, () => { const t = $('#f-title'); if (t && !id) t.focus(); });
}
function settingsSheet() {
  openSheet(`
    <h3>設定</h3>
    <div class="muted small">目前身分：${esc(S.auth.user)}${S.auth.demo ? '（示範資料，改了不會存）' : ''}</div>
    <button class="btn" data-act="refresh">🔄 重新整理資料</button>
    <button class="btn" data-act="logout">換人／重新登入</button>
    <div class="acts"><div class="right"><button class="btn" data-act="sheet-close">關閉</button></div></div>`);
}

/* ---------------- 提示 ---------------- */
let toastTimer;
function toast(msg, undo) {
  const root = $('#toast-root');
  root.innerHTML = `<div class="toast"><span>${esc(msg)}</span>${undo ? '<button data-act="undo">復原</button>' : ''}</div>`;
  toast.undo = undo || null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ''; toast.undo = null; }, undo ? 5000 : 2600);
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
  S.error = '';
  render();
  try {
    S.data = await fetchAll();
    store.set('cache', { at: Date.now(), demo: !!S.auth.demo, data: S.data });
  } catch (err) {
    S.error = '讀不到資料：' + err.message;
  }
  render();
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  if (act === 'sheet-close') { if (e.target === el || el.tagName === 'BUTTON') closeSheet(); return; }

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
    case 'demo': S.auth = { user: S.loginUser || '朱', key: null, demo: true }; loadData(); break;
    case 'logout': store.del('auth'); store.del('cache'); S.auth = null; S.data = null; closeSheet(); render(); break;
    case 'retry': loadData(); break;
    case 'refresh': closeSheet(); await loadData(); toast('資料更新好了'); break;
    case 'settings': settingsSheet(); break;
    case 'tab': S.tab = v; store.set('tab', v); render.scrolled = false; closeSheet(); render(); window.scrollTo(0, 0); break;
    case 'date': S.date = v; render(); break;
    case 'reco-more': S.recoOpen[v] = !S.recoOpen[v]; render(); break;
    case 'add-reco': {
      const p = placeById(v);
      const slot = el.dataset.slot;
      const n = rows('行程').filter((r) => r['日期'] === S.date).length + 1;
      addRow('行程', { 日期: S.date, 時段: slot, '地點 ID': p.ID, 名稱: p['名稱'], 排序: n }, `已加進 ${md(S.date)} ${slot}`);
      break;
    }
    case 'edit-item': editItemSheet(v); break;
    case 'item-save': {
      updateRow('行程', v, { 時段: $('#f-slot').value, 時間: $('#f-time').value, 備註: $('#f-note').value }, '存好了');
      closeSheet();
      break;
    }
    case 'item-remove': closeSheet(); updateRow('行程', v, { 已刪除: true }, '已移除', { 已刪除: false }); break;
    case 'heart': toggleHeart(v); break;
    case 'pf-city': S.pf.city = v; S.pf.region = '全部'; render(); break;
    case 'pf-type': S.pf.type = v; render(); break;
    case 'pf-region': S.pf.region = v; render(); break;
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
    case 'book-save':
      updateRow('預約', v, { 票在誰手上: $('#f-holder').value, 票券位置: $('#f-where').value, 備註: $('#f-note').value }, '存好了');
      closeSheet();
      break;
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
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.auth && S.data && !S.auth.demo) {
    fetchAll().then((d) => { S.data = d; render(); }).catch(() => {});
  }
});
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(paintTiles, 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintTiles);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(paintTiles);

/* ---------------- 啟動 ---------------- */
(function start() {
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (isLocal && new URLSearchParams(location.search).has('demo')) S.auth = { user: '朱', key: null, demo: true };
  if (!S.auth) { render(); return; }
  const cache = store.get('cache');
  if (cache && cache.data && !!cache.demo === !!S.auth.demo) { S.data = cache.data; render(); }
  loadData();
})();
