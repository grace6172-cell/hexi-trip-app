/**
 * 荷西旅遊 App 後端（Google Apps Script Web App）
 *
 * 讀寫同一份 Google 試算表「荷西App資料表」。
 * 部署方式見 apps-script/README.md。
 *
 * Script Properties（專案設定 → 指令碼屬性）：
 *   PASSCODE  旅行通行碼，四個人共用；必填
 */

const USERS = ['淇淇', '婷婷', '宜宜', '慧慧'];
// 2026-10-12 改名前的舊代號：還沒更新的手機送舊名字進來，一律記成新名字
const OLD_NAMES = { 妹妹: '淇淇', 簡: '婷婷', 十一: '宜宜', 朱: '慧慧' };

// 讀取時回傳的分頁（「說明」不給 app）
const READ_SHEETS = ['每日', '行程', '地點', '預約', '購物', '待辦', '日誌', '日誌留言', '工具箱'];

// 每個分頁 app 可以做的事：add 時可填的欄位、update 時可改的欄位
const RULES = {
  '行程': {
    idPrefix: 'I',
    add: ['日期', '時段', '時間', '類別', '地點 ID', '名稱', '備註', '排序'],
    update: ['日期', '時段', '時間', '名稱', '備註', '排序', '已刪除'],
    addDefaults: { '類別': '行程', '來源': 'app 新增', '已刪除': false },
    authorField: '新增者',
  },
  '地點': {
    idPrefix: 'P',
    add: ['名稱', 'Google 地圖連結', '類型', '特色'],
    update: ['已去過', '特色', '營業提醒', '交通', '價位'],
    addDefaults: { '已去過': false, '來源': 'app 新增', '查證狀態': '待同步：地址、座標、營業時間' },
  },
  '預約': {
    idPrefix: 'R',
    add: [],
    update: ['時間', '狀態', '票在誰手上', '票券位置', '備註'],
    updaterField: '更新者',
  },
  '購物': {
    idPrefix: 'S',
    add: ['商品', '哪裡買', '參考價', '說明', '地點 ID', '順路日期'],
    update: ['已買', '已刪除'],
    addDefaults: { '已買': false, '已刪除': false, '來源': 'app 新增', '查證狀態': '' },
  },
  '待辦': {
    idPrefix: 'T',
    add: ['項目', '說明', '負責人'],
    update: ['項目', '說明', '負責人', '完成', '已刪除'],
    addDefaults: { '完成': false, '已刪除': false },
    authorField: '建立者',
  },
  // 每日沒有 ID 欄，用日期找列；城市、城市代碼影響畫面邏輯，不開放
  '每日': {
    idField: '日期',
    add: [],
    update: ['Summary', '提醒', '住宿'],
  },
  // 日誌：每人每天一則，四個欄位＋滿意度都必填；日誌和留言只有作者本人能改、能刪（ownerOnly）
  '日誌': {
    idPrefix: 'J',
    add: ['日期', '滿意度', '總結', '感謝', '投訴', '其他'],
    update: ['滿意度', '總結', '感謝', '投訴', '其他', '已刪除'],
    addDefaults: { '已刪除': false },
    authorField: '作者',
    timeField: '時間',
    editedField: '修改時間',
    ownerOnly: true,
  },
  '日誌留言': {
    idPrefix: 'C',
    add: ['日誌 ID', '內容'],
    update: ['內容', '已刪除'],
    addDefaults: { '已刪除': false },
    authorField: '作者',
    timeField: '時間',
    ownerOnly: true,
  },
};

const BOOL_FIELDS = ['已去過', '已買', '完成', '已刪除'];
const STATUS_VALUES = ['未訂', '已訂', '已取消'];
const JOURNAL_FIELDS = ['總結', '感謝', '投訴', '其他'];
const REACTIONS = ['❤️', '😂', '👍', '😮', '😢'];
const HEART_FIELD = '按 ❤️ 的人';

/* ---------------- 入口 ---------------- */

function doGet(e) {
  return handle_(() => {
    const p = (e && e.parameter) || {};
    if (p.action === 'ping') return { ok: true, sheets: READ_SHEETS.length };
    checkKey_(p.key);
    if (p.action === 'all' || !p.action) return { ok: true, data: readAll_(), serverTime: new Date().toISOString() };
    throw new Error('不支援的動作：' + p.action);
  });
}

function doPost(e) {
  return handle_(() => {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    const user = checkUser_(body.user);
    const lock = LockService.getDocumentLock();
    lock.waitLock(10000);
    try {
      let row;
      switch (body.action) {
        case 'add':    row = addRow_(body.sheet, body.fields || {}, user); break;
        case 'update': row = updateRow_(body.sheet, body.id, body.fields || {}, user); break;
        case 'heart':  row = toggleHeart_(body.id, user); break;
        case 'react':  row = toggleReaction_(body.id, body.emoji, user); break;
        default: throw new Error('不支援的動作：' + body.action);
      }
      logChange_(user, body, row);
      return { ok: true, row };
    } finally {
      lock.releaseLock();
    }
  });
}

/* ---------------- 異動紀錄 ----------------
 * 試算表的版本記錄只會顯示部署者（Grace），
 * 所以每次從 app 寫入都另外記一筆：誰、什麼時候、改了哪裡。 */
const LOG_SHEET = '異動紀錄';
const ACTION_NAME = { add: '新增', update: '修改', heart: '按 ❤️', react: '回應' };

function logChange_(user, body, row) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(LOG_SHEET);
      sh.appendRow(['時間', '誰', '動作', '分頁', 'ID', '項目', '內容']);
      sh.setFrozenRows(1);
    }
    const sheet = body.action === 'heart' ? '購物' : body.action === 'react' ? '日誌' : body.sheet;
    const name = row ? (row['名稱'] || row['Summary'] || row['總結'] || row['項目'] || row['商品'] || row['內容'] || '') : '';
    const detail = body.action === 'heart' ? (row && row[HEART_FIELD]) || '（沒人按）'
      : body.action === 'react' ? body.emoji + '：' + ((row && row['反應']) || '（沒人回應）')
      : Object.keys(body.fields || {}).map((k) => k + '：' + body.fields[k]).join('；');
    sh.appendRow([
      Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm:ss'),
      user, ACTION_NAME[body.action] || body.action, sheet,
      (row && row.ID) || body.id || '', String(name).slice(0, 100), String(detail).slice(0, 500),
    ]);
  } catch (err) {
    // 記錄失敗不能讓使用者的修改失敗
    console.error('logChange_ failed: ' + err);
  }
}

function handle_(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- 驗證 ---------------- */

function checkKey_(key) {
  const pass = PropertiesService.getScriptProperties().getProperty('PASSCODE');
  if (!pass) throw new Error('伺服器還沒設定通行碼（PASSCODE）');
  if (key !== pass) throw new Error('通行碼不對');
}

function checkUser_(user) {
  if (OLD_NAMES[user]) user = OLD_NAMES[user];
  if (USERS.indexOf(user) < 0) throw new Error('不認得這位旅伴：' + user);
  return user;
}

/* ---------------- 讀 ---------------- */

function readAll_() {
  const ss = SpreadsheetApp.getActive();
  const data = {};
  READ_SHEETS.forEach(name => {
    const sh = ss.getSheetByName(name);
    data[name] = sh ? sheetToObjects_(sh) : [];
  });
  return data;
}

function sheetToObjects_(sh) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  const idCol = headers.indexOf('ID');
  return values.slice(1)
    // 有 ID 欄的分頁只回傳有 ID 的列；空白核取方塊（FALSE）不算有資料
    .filter(r => (idCol >= 0 ? String(r[idCol]).trim() !== '' : r.some(c => c !== '' && c !== null && c !== false)))
    .map(r => {
      const o = {};
      headers.forEach((h, i) => { if (h) o[h] = normalize_(r[i]); });
      return o;
    });
}

function normalize_(v) {
  if (!(v instanceof Date)) return v;
  const hasTime = Utilities.formatDate(v, 'Europe/Madrid', 'HH:mm') !== '00:00';
  return Utilities.formatDate(v, 'Europe/Madrid', hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
}

/* ---------------- 寫 ---------------- */

function getTable_(sheetName) {
  if (!RULES[sheetName]) throw new Error('這個分頁不能在 app 裡修改：' + sheetName);
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh) throw new Error('找不到分頁：' + sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  return { sh, headers, rule: RULES[sheetName] };
}

function lastIdRow_(t) {
  const idCol = t.headers.indexOf('ID') + 1;
  const last = t.sh.getLastRow();
  if (last < 2) return 1;
  const ids = t.sh.getRange(2, idCol, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]).trim() !== '') return i + 2;
  return 1;
}

function findRow_(t, id) {
  const idCol = t.headers.indexOf(t.rule.idField || 'ID') + 1;
  const last = t.sh.getLastRow();
  if (last < 2) throw new Error('找不到 ' + id);
  const ids = t.sh.getRange(2, idCol, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(normalize_(ids[i][0])) === String(id)) return i + 2;
  throw new Error('找不到 ' + id);
}

function cleanValue_(field, value) {
  if (BOOL_FIELDS.indexOf(field) >= 0) return value === true || value === 'TRUE' || value === 'true';
  if (field === '狀態' && STATUS_VALUES.indexOf(value) < 0) throw new Error('狀態只能是：' + STATUS_VALUES.join('、'));
  if (field === '滿意度') {
    if (value === '' || value === null || value === undefined) return '';
    const n = Math.round(Number(value));
    if (!(n >= 0 && n <= 5)) throw new Error('滿意度只能是 0 到 5');
    return n;
  }
  // 日誌不限字數（試算表一格上限 5 萬字，這裡留 2 萬當保險）
  const max = JOURNAL_FIELDS.indexOf(field) >= 0 ? 20000 : 2000;
  return value === null || value === undefined ? '' : String(value).slice(0, max);
}

/** 新增日誌前檢查：日期、滿意度、四個欄位都要有；同一人同一天只能一則 */
function checkJournal_(t, fields, user) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fields['日期'] || ''))) throw new Error('日期不對');
  JOURNAL_FIELDS.concat('滿意度').forEach(f => {
    if (fields[f] === undefined || fields[f] === null || String(fields[f]).trim() === '') throw new Error('「' + f + '」要寫喔');
  });
  const last = t.sh.getLastRow();
  if (last < 2) return;
  const cDate = t.headers.indexOf('日期'), cAuthor = t.headers.indexOf('作者'), cDel = t.headers.indexOf('已刪除');
  const dup = t.sh.getRange(2, 1, last - 1, t.headers.length).getValues().some(r =>
    normalize_(r[cDate]) === fields['日期'] && r[cAuthor] === user && r[cDel] !== true);
  if (dup) throw new Error('你這天已經寫過了，請直接編輯那一則');
}

function addRow_(sheetName, fields, user) {
  const t = getTable_(sheetName);
  if (!t.rule.add.length) throw new Error('這個分頁不能新增');
  if (sheetName === '日誌') checkJournal_(t, fields, user);

  const row = {};
  Object.assign(row, t.rule.addDefaults || {});
  t.rule.add.forEach(f => { if (f in fields) row[f] = cleanValue_(f, fields[f]); });
  if (t.rule.authorField) row[t.rule.authorField] = user;
  if (t.rule.timeField) row[t.rule.timeField] = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
  row['ID'] = nextId_(t);

  const values = t.headers.map(h => (h in row ? row[h] : ''));
  // 不用 appendRow：下面如果有空白的核取方塊列，appendRow 會把資料寫到很遠的地方。
  // 改成寫在「最後一個有 ID 的列」的下一列。
  const r = lastIdRow_(t) + 1;
  if (r > t.sh.getMaxRows()) t.sh.insertRowsAfter(t.sh.getMaxRows(), 1);
  t.sh.getRange(r, 1, 1, values.length).setValues([values]);
  // 新列的勾選欄也要是核取方塊
  t.headers.forEach((h, i) => {
    if (BOOL_FIELDS.indexOf(h) >= 0) t.sh.getRange(r, i + 1).insertCheckboxes();
  });
  return rowObject_(t, r);
}

function updateRow_(sheetName, id, fields, user) {
  const t = getTable_(sheetName);
  const r = findRow_(t, id);
  const keys = Object.keys(fields);
  if (!keys.length) throw new Error('沒有要更新的欄位');
  if (t.rule.ownerOnly) {
    const author = t.sh.getRange(r, t.headers.indexOf(t.rule.authorField) + 1).getValue();
    if (author !== user) throw new Error('只有 ' + author + ' 本人可以修改這則');
  }
  if (sheetName === '日誌' && !fields['已刪除']) JOURNAL_FIELDS.concat('滿意度').forEach(f => { if (f in fields && String(fields[f]).trim() === '') throw new Error('「' + f + '」要寫喔'); });
  keys.forEach(f => {
    if (t.rule.update.indexOf(f) < 0) throw new Error('「' + f + '」不能在 app 裡修改');
    const c = t.headers.indexOf(f);
    if (c < 0) throw new Error('找不到欄位：' + f);
    t.sh.getRange(r, c + 1).setValue(cleanValue_(f, fields[f]));
  });
  if (t.rule.editedField && !('已刪除' in fields)) {
    const c = t.headers.indexOf(t.rule.editedField);
    if (c >= 0) t.sh.getRange(r, c + 1).setValue(Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm'));
  }
  if (t.rule.updaterField) {
    const c = t.headers.indexOf(t.rule.updaterField);
    if (c >= 0) t.sh.getRange(r, c + 1).setValue(user);
  }
  const out = rowObject_(t, r);
  // 行程和預約的時間互相同步：同一天、同一個地點 ID 的另一邊也一起改
  if ('時間' in fields && (sheetName === '行程' || sheetName === '預約') && out['地點 ID']) {
    syncTime_(sheetName === '行程' ? '預約' : '行程', out['日期'], out['地點 ID'], out['時間']);
  }
  return out;
}

function syncTime_(sheetName, date, placeId, time) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const cDate = headers.indexOf('日期'), cPlace = headers.indexOf('地點 ID'), cTime = headers.indexOf('時間'), cDel = headers.indexOf('已刪除');
  if (cDate < 0 || cPlace < 0 || cTime < 0) return;
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  values.forEach((row, i) => {
    if (normalize_(row[cDate]) === date && row[cPlace] === placeId && !(cDel >= 0 && row[cDel] === true)) {
      const cell = sh.getRange(i + 2, cTime + 1);
      cell.setNumberFormat('@');
      cell.setValue(time);
    }
  });
}

function toggleHeart_(id, user) {
  const t = getTable_('購物');
  const r = findRow_(t, id);
  const c = t.headers.indexOf(HEART_FIELD) + 1;
  const cell = t.sh.getRange(r, c);
  const people = String(cell.getValue() || '').split(/[,，、]\s*/).filter(Boolean);
  const i = people.indexOf(user);
  if (i >= 0) people.splice(i, 1); else people.push(user);
  cell.setValue(people.join('、'));
  return rowObject_(t, r);
}

/** 日誌的表情回應：存成 JSON 字串 {"❤️":["慧慧","淇淇"]}；同一個表情再按一次就收回 */
function toggleReaction_(id, emoji, user) {
  if (REACTIONS.indexOf(emoji) < 0) throw new Error('不支援這個表情');
  const t = getTable_('日誌');
  const r = findRow_(t, id);
  const cell = t.sh.getRange(r, t.headers.indexOf('反應') + 1);
  let map = {};
  try { map = JSON.parse(cell.getValue() || '{}'); } catch (err) { map = {}; }
  const people = map[emoji] || [];
  const i = people.indexOf(user);
  if (i >= 0) people.splice(i, 1); else people.push(user);
  if (people.length) map[emoji] = people; else delete map[emoji];
  cell.setValue(Object.keys(map).length ? JSON.stringify(map) : '');
  return rowObject_(t, r);
}

function nextId_(t) {
  const idCol = t.headers.indexOf('ID') + 1;
  const last = t.sh.getLastRow();
  let max = 0;
  if (last >= 2) {
    t.sh.getRange(2, idCol, last - 1, 1).getValues().forEach(([v]) => {
      const m = String(v).match(/(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  return t.rule.idPrefix + String(max + 1).padStart(2, '0');
}

function rowObject_(t, r) {
  const vals = t.sh.getRange(r, 1, 1, t.headers.length).getValues()[0];
  const o = {};
  t.headers.forEach((h, i) => { if (h) o[h] = normalize_(vals[i]); });
  return o;
}

/* ---------------- 在編輯器裡手動測試用 ---------------- */

function testReadAll() {
  const data = readAll_();
  Object.keys(data).forEach(k => Logger.log(k + '：' + data[k].length + ' 筆'));
}
