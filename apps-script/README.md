# Apps Script 後端

app 透過這支程式讀寫 Google 試算表「荷西App資料表」。試算表本身不公開，只有這支程式能碰它。

## 部署步驟（只要做一次）

1. 打開 [荷西App資料表](https://docs.google.com/spreadsheets/d/1hZBi4MEFpQloD5atiw45zhO4zAXBeuHykaaj-lC9llw/edit)，選 **擴充功能 → Apps Script**。
2. 把編輯器裡原本的 `Code.gs` 內容全部刪掉，貼上這個資料夾的 `Code.gs`，按儲存（Ctrl+S）。
3. 左側齒輪 **專案設定**：
   - 時區選「(GMT+01:00) 馬德里」（或勾「在編輯器中顯示 appsscript.json」後，把內容換成這個資料夾的 `appsscript.json`）。
   - 最下方 **指令碼屬性 → 新增指令碼屬性**：屬性 `PASSCODE`，值填你們四個人約好的旅行通行碼。
4. 回到編輯器，上方函式選 `testReadAll`，按 **執行**。第一次會跳授權：
   - 選你的 Google 帳號 → 出現「Google 尚未驗證這個應用程式」→ 點 **進階** → **前往（不安全）** → **允許**。這是你自己寫的程式，所以 Google 沒有審核過，屬正常。
   - 執行紀錄應該列出每個分頁的筆數（行程 22 筆、地點 57 筆……）。
5. 右上角 **部署 → 新增部署作業**：
   - 類型：**網頁應用程式**
   - 執行身分：**我**
   - 誰可以存取：**所有人**
   - 按部署，複製「網頁應用程式網址」（`https://script.google.com/macros/s/.../exec`）。

## 改程式碼之後

**部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署**。網址不變。直接「新增部署作業」會產生新網址，app 就要跟著改。

## API

| 方法 | 參數 | 用途 |
|---|---|---|
| GET | `?action=ping` | 測試部署是否成功，不需要通行碼 |
| GET | `?action=all&key=通行碼` | 讀所有分頁（說明頁除外） |
| POST | `{"key","user","action":"add","sheet","fields"}` | 新增一列，ID 自動產生 |
| POST | `{"key","user","action":"update","sheet","id","fields"}` | 修改指定欄位 |
| POST | `{"key","user","action":"heart","id"}` | 購物清單按／取消 ❤️ |

POST 用 `Content-Type: text/plain` 送 JSON，避免瀏覽器的跨網域預檢。

`user` 只能是：妹妹、簡、十一、朱。每個分頁能新增、能改哪些欄位，寫在 `Code.gs` 的 `RULES`；工具箱、每日只能讀。
