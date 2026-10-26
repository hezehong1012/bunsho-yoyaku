# AI要約くん - デプロイ手順

## ファイル構成
```
ai-yoyaku/
├── index.html              # ホームページ（ツール本体）
├── bunsho-yoyaku/
│   └── index.html          # 文章要約 内ページ
├── api/
│   └── summarize.js        # Vercel Serverless Function（AI要約API）
├── privacy.html            # プライバシーポリシー
├── terms.html              # 利用規約
└── README.md               # 本ファイル
```

## ローカルでのプレビュー

index.html をブラウザで直接開けばUIは確認できます。
API（要約機能）をローカルで試すには：

```bash
# Vercel CLI をインストール
npm i -g vercel

# プロジェクトディレクトリで
vercel dev
```

http://localhost:3000 でアクセス。

## Vercel にデプロイする手順

### 1. GitHub にプッシュ
```bash
cd ai-yoyaku
git init
git add .
git commit -m "initial commit"
# GitHubでリポジトリ作成後
git remote add origin https://github.com/<あなたのアカウント>/ai-yoyaku.git
git push -u origin main
```

### 2. Vercel にインポート
1. https://vercel.com にアクセス（GitHubアカウントでログイン）
2. "Add New Project" → 先ほどのリポジトリをインポート
3. フレームワークプリセットは「Other」のまま Deploy
4. 数秒でデプロイ完了 → `xxx.vercel.app` のURLが発行される

### 3. 環境変数を設定
Vercelダッシュボード → Project → Settings → Environment Variables:

| Name | Value | 説明 |
|---|---|---|
| `LLM_API_KEY` | sk-xxxx... | DeepSeek または OpenAI の APIキー |
| `LLM_API_URL` | https://api.deepseek.com/v1/chat/completions | （省略可・DeepSeekデフォルト） |
| `LLM_MODEL` | deepseek-chat | （省略可） |

DeepSeek APIキーの取得: https://platform.deepseek.com/
（OpenAI互換なので、OpenAIキーでも動きます）

設定後、Deployments → 最新のデプロイ → "Redeploy" をクリック。

### 4. カスタムドメインを追加
Vercelダッシュボード → Settings → Domains → ドメインを入力 → Add。

---

## ドメイン登録先（推奨順）

| サービス | URL | 価格（.com/年） | 特徴 |
|---|---|---|---|
| **Cloudflare Registrar** | https://www.cloudflare.com/products/registrar/ | 約 ¥1,200（原価） | **最推奨**：原価売り上げ・手数料なし・更新も安い |
| Namecheap | https://www.namecheap.com/ | 約 ¥1,500〜2,000 | 日本語対応・初年度割引あり |
| Porkbun | https://porkbun.com/ | 約 ¥1,200〜1,500 | 安い・UIがシンプル |
| Google Domains | https://domains.google/ | 約 ¥1,500 | 安定・ただし現在は新規受付停止中 |

### ドメイン名の候補
- `ai-yoyaku.com`
- `bunsho-yoyaku.com`
- `yoyaku-ai.com`
- `yoyaku-tool.com`

**登録時の注意**：
- ✅ Cloudflare Registrar で登録すれば、DNS設定がワンクリック
- ❌ 日本の国内業者（お名前.com、ムームードメイン）は避ける（DNS遅い・高い）
- ❌ `.ai` ドメインは高い（¥15,000/年〜）ので避ける
- ✅ `.com` 最優先、取れなければ `-`（ハイフン）入りで

---

## デプロイ後のやること

1. **Google Search Console に登録**
   - https://search.google.com/search-console
   - ドメインを追加 → 所有権確認（DNSレコード or HTMLタグ）
   - sitemap.xml を提出（後で追加）

2. **Google Analytics 4 を設定**
   - https://analytics.google.com
   - 測定IDを取得 → index.html の `</body>` 直前に追加

3. **Adsense 申請**
   - まず数週間トラフィックを集めてから申請するのが通りやすい
   - ルートに `ads.txt` を設置
