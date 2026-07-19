# 沖縄旅のしおり

沖縄旅行用の、日ごとスケジュール型しおりアプリ。家族で同じURLを開けば同じ内容を見られるよう、自宅Macで動くNode.js(Express)サーバー＋SQLiteで構成しています。

## 使い方

1. 「📍 行きたい場所」タブで、行きたいお店・スポットを登録する。
   - 住所を入力して「住所を検索」を押すと緯度経度を自動取得（OpenStreetMap Nominatimを利用、APIキー不要）。名前だけでも一部の有名スポットは検索できる。
   - 駐車場が複数あるお店などは「追加の場所」に第2駐車場等を個別に登録できる。それぞれ専用のGoogleマップリンクが表示される。
   - 移動手段（車/飛行機/電車/徒歩）、食事タイミング、固定時刻（飛行機の到着時刻など）を場所ごとに設定できる。
2. 「🗺️ 日程」タブで、登録した場所を各日に追加し、時刻は自分で入力する。アプリは予定と予定の間の移動時間に無理がないかだけを確認する（車移動の場合のみ、直線距離ベースの推定）。
3. 右上の⚙️「旅の設定」から拠点（ホテル）や旅行日数、データのバックアップ（書き出し/読み込み）ができる。

## 技術構成

- フロントエンド: ビルド不要のHTML/CSS/バニラJS（ESモジュール）、PWA対応
- バックエンド: Node.js + Express（`server.js`）。フロントエンドの配信とAPIの両方を担う
- データ保存: SQLite（`data/trip.db`、gitignore対象）。ブラウザのlocalStorageは起動時のオフライン用キャッシュとしてのみ使う
- 認証: 合い言葉をURLの `?key=` に付けて一度アクセスするとクッキーが発行され、以後30日は再入力不要（`auth.js`）
- 家族間の同期: 20秒ごとにサーバーへポーリングし、他の端末での変更を自動的に反映する
- 公開方法: 自宅MacでLaunchAgentとして常駐（`~/Library/LaunchAgents/com.okinawa-trip.server.plist`）し、Cloudflare Tunnel経由で `https://trip.teppeitakahata.com` として公開
- 住所→緯度経度変換: OpenStreetMap Nominatim（無料・APIキー不要）
- 地図遷移: Googleマップの検索/ルートURLスキームを直接利用

## セットアップ（初回のみ）

```
npm install
```

`config.local.json`（gitignore対象）を作成し、合い言葉を設定する:

```json
{ "passphrase": "好きな合い言葉" }
```

## 起動

```
npm start
```

または LaunchAgent で自動起動・自動再起動:

```
launchctl load ~/Library/LaunchAgents/com.okinawa-trip.server.plist
```

## 移動時間の推定について

移動時間は、2点間の直線距離から沖縄の道路事情を踏まえた速度想定で計算した**参考値**です（車移動のみ）。飛行機・電車・徒歩の区間は推定しません。実際のルートや所要時間は各予定の「ここまでのルート」リンクから必ずGoogleマップ等でご確認ください。

## 更新時の注意

`sw.js` はオフラインキャッシュのため一度読み込んだファイルを強めにキャッシュします。デプロイ後に更新が反映されない場合は `sw.js` 先頭の `CACHE` のバージョン文字列を上げてください。

サーバー側のコード（`server.js`/`db.js`/`auth.js`）を変更した場合は、以下でサーバーを再起動する:

```
launchctl kickstart -k gui/$(id -u)/com.okinawa-trip.server
```
