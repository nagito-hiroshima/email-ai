# Email Summary Discord Worker

Cloudflare Workers と Workers AI を使って受信メールを日本語で要約し、Discord Webhook に通知するシンプルなワーカーです。

主なファイル
- [index.js](index.js) — 実装本体（メールパース、AI要約、Discord送信など）
  - 重要な関数: [`summarizeEmailWithWorkersAI`](index.js), [`sendDiscordWebhook`](index.js)
- [wrangler.toml](wrangler.toml) — デプロイ設定と AI バインディング

特徴
- Cloudflare Email Routing から受信したメールをパースして要約
- Workers AI（binding: `AI`）を使って日本語で要約
- 要約を Discord Webhook に埋め込み形式で通知
- テスト用エンドポイント:
  - GET /test-discord — Discord 通知テスト
  - GET /test-ai — AI 要約テスト

セットアップ
1. wrangler で Worker を作成／配置する（wrangler の設定は [wrangler.toml](wrangler.toml) を参照）。
2. 環境変数（wrangler [vars]）を設定:
   - DISCORD_WEBHOOK_URL — Discord の Webhook URL（必須）
   - AI_MODEL — 使用する Workers AI モデル（例: `@cf/openai/gpt-oss-120b`。既に [wrangler.toml](wrangler.toml) に設定済み）
   - FORWARD_TO — （任意）元メールを転送する宛先
3. AI バインディング名は `AI` にしてください（[wrangler.toml](wrangler.toml) の [ai] セクション参照）。

デプロイ
```sh
wrangler publish