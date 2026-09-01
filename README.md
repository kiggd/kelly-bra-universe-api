# 凱莉愛內衣宇宙 V5 後端（Vercel 版）

架構：Vercel Serverless Function + Vercel Postgres（Neon）。

## 部署流程

1. 把本目錄推上 GitHub repo（例如 `kiggd/kelly-bra-universe-api`）。
2. Vercel Dashboard → Add New → Project → Import Git Repository → 選該 repo → Deploy。
3. Vercel Dashboard → Storage → Create Postgres → 命名 `bra-universe` → Create →
   Connect to project（選該專案），Vercel 會自動注入 `POSTGRES_URL` 並重新部署。
4. 在資料庫執行 `schema.sql`（本機可用 `psql`，或 Vercel Storage 的 Query 頁面）。
5. 部署完成後 `https://<project>.vercel.app/api/universe/health` 應回 `{"ok":true}`。

## 環境變數（可選）

| 變數 | 說明 |
|---|---|
| `LINE_CHANNEL_ID` | 預設 `1608559038`（凱莉愛內衣 LINE Login channel） |
| `EMAIL_API_KEY` / `EMAIL_FROM` | Resend；未設時驗證碼只寫 log（開發用） |
| `GA4_MEASUREMENT_ID` / `GA4_API_SECRET` | 事件轉送 GA4 |
| `ALLOWED_ORIGINS` | CORS 白名單，預設含 kellylove.tw 與 GitHub Pages |

JWT 密鑰不需設定：首次啟動自動產生並存入 `settings` 資料表。

## 前端接線

```js
apiBase: 'https://<project>.vercel.app/api/universe',
```
