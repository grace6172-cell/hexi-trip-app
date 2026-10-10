/**
 * 荷西旅遊 App 後端（Google Apps Script Web App）
 *
 * 讀寫同一份 Google 試算表「荷西App資料表」。
 * 部署方式見 apps-script/README.md。
 *
 * Script Properties（專案設定 → 指令碼屬性）：
 *   PASSCODE  旅行通行碼，四個人共用；必填
 */

const USERS = ['妹妹', '簡', '十一', '朱'];

// 讀取時回傳的分頁（「說明」不給 app）
const READ_SHEETS = ['每日', '行程', '地點', '預約', '購物', '待辦', '日誌', '工具箱'];

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
    update: ['已去過'],
    addDefaults: { '已去過': false, '來源': 'app 新增', '查證狀態': '待同步：地址、座標、營業時間' },
  },
  '預約': {
    idPrefix: 'R',
    add: [],
    update: ['狀態', '票在誰手上', '票券位置', '備註'],
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
  '日誌': {
    idPrefix: 'J',
    add: ['類型', '內容'],
    update: [],
    authorField: '作者',
    timeField: '時間',
  },
};

const BOOL_FIELDS = ['已去過', '已買', '完成', '已刪除'];
const STATUS_VALUES = ['未訂', '已訂', '已取消'];
const JOURNAL_TYPES = ['💬 想說的話', '😤 想投訴', '💭 心情'];
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
      switch (body.action) {
        case 'add':    return { ok: true, row: addRow_(body.sheet, body.fields || {}, user) };
        case 'update': return { ok: true, row: updateRow_(body.sheet, body.id, body.fields || {}, user) };
        case 'heart':  return { ok: true, row: toggleHeart_(body.id, user) };
        default: throw new Error('不支援的動作：' + body.action);
      }
    } finally {
      lock.releaseLock();
    }
  });
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
  return values.slice(1)
    .filter(r => r.some(c => c !== '' && c !== null))
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

function findRow_(t, id) {
  const idCol = t.headers.indexOf('ID') + 1;
  const last = t.sh.getLastRow();
  if (last < 2) throw new Error('找不到 ' + id);
  const ids = t.sh.getRange(2, idCol, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  throw new Error('找不到 ' + id);
}

function cleanValue_(field, value) {
  if (BOOL_FIELDS.indexOf(field) >= 0) return value === true || value === 'TRUE' || value === 'true';
  if (field === '狀態' && STATUS_VALUES.indexOf(value) < 0) throw new Error('狀態只能是：' + STATUS_VALUES.join('、'));
  if (field === '類型' && JOURNAL_TYPES.indexOf(value) >= 0) return value;
  return value === null || value === undefined ? '' : String(value).slice(0, 2000);
}

function addRow_(sheetName, fields, user) {
  const t = getTable_(sheetName);
  if (!t.rule.add.length) throw new Error('這個分頁不能新增');
  if (sheetName === '日誌' && JOURNAL_TYPES.indexOf(fields['類型']) < 0) throw new Error('日誌類型不對');

  const row = {};
  Object.assign(row, t.rule.addDefaults || {});
  t.rule.add.forEach(f => { if (f in fields) row[f] = cleanValue_(f, fields[f]); });
  if (t.rule.authorField) row[t.rule.authorField] = user;
  if (t.rule.timeField) row[t.rule.timeField] = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd HH:mm');
  row['ID'] = nextId_(t);

  const values = t.headers.map(h => (h in row ? row[h] : ''));
  t.sh.appendRow(values);
  const r = t.sh.getLastRow();
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
  keys.forEach(f => {
    if (t.rule.update.indexOf(f) < 0) throw new Error('「' + f + '」不能在 app 裡修改');
    const c = t.headers.indexOf(f);
    if (c < 0) throw new Error('找不到欄位：' + f);
    t.sh.getRange(r, c + 1).setValue(cleanValue_(f, fields[f]));
  });
  if (t.rule.updaterField) {
    const c = t.headers.indexOf(t.rule.updaterField);
    if (c >= 0) t.sh.getRange(r, c + 1).setValue(user);
  }
  return rowObject_(t, r);
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
