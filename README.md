# 荷西行

瘋女紙荷西行（阿姆斯特丹 × 巴塞隆納，2026/10/22–11/1）四人共用的旅遊 app。

- `web/`：手機網頁 app（PWA），純 HTML／CSS／JS，不需要建置
- `apps-script/`：Google Apps Script 後端，讀寫 Google 試算表「荷西App資料表」，部署方式見該資料夾 README

資料都在 Google 試算表，app 需要旅行通行碼才讀得到。

## 本機預覽

用任何靜態伺服器開 `web/`，例如在 `web/` 裡執行 `python -m http.server 8765`，再開 `http://localhost:8765/?demo`。
`?demo` 讀的是 `web/demo-data.json`，這個檔案含個人資料，不放進 repo；只在 localhost 有效。
