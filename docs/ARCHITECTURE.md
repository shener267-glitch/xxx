# Pocket Engine アーキテクチャ

このドキュメントは、今後のフェーズで機能を追加する開発者向けに、Phase 1 の設計方針をまとめたものです。

## 全体像

```
┌──────────────── UI (src/ui) ────────────────┐
│ TopBar / ToolBar / BottomSheet / 各パネル / モーダル │
└───────────────┬─────────────────────────────┘
                │ actions.ts を呼ぶ / Editor のイベントを購読
┌───────────────▼────────────── core ─────────┐
│ Editor (状態) ── SceneModel (シーンデータ)      │
│    │               ▲                          │
│    └ History ── Command (Add/Remove/Update/   │
│                 SetTransforms/Snapshot)        │
└───────┬───────────────────────────┬─────────┘
        │ イベント                     │ 複製 (Play 開始時)
┌───────▼──── engine ─────┐   ┌──────▼──── runtime ─────┐
│ SceneBridge → Three.js    │   │ GameRuntime (独立シーン)   │
│ EditorViewport / Gizmo    │   │ コンポーネント実行 / カメラ │
│ ViewportInput (タッチ)    │   │ RuntimeInput (ジョイスティック) │
└──────────────────────────┘   └─────────────────────────┘
                 共通: SceneBuilder (EntityData → Object3D)
```

## 原則

1. **データが唯一の正**: 編集データはすべてプレーンな JSON (`core/types.ts`)。
   Three.js のオブジェクトはデータから作られる表示にすぎない。
   そのため保存・Undo/Redo・Play のスナップショットは「データの複製」だけで実現できる。
2. **変更はすべてコマンド経由**: `core/actions.ts` の関数がコマンドを作り `Editor.execute()` で実行する。
   Undo/Redo・自動保存 (dirty フラグ)・選択状態の復元は Editor が一括で扱う。
3. **イベント駆動の表示更新**: `SceneModel` が `entity-added / removed / changed / hierarchy-changed / scene-loaded`
   を発行し、`SceneBridge` (3D) と各パネル (UI) が差分だけを更新する。
4. **core は DOM・描画に依存しない**: `tests/` の単体テストで Node 上から検証できる。
5. **runtime はエディタに依存しない**: Phase 10 のゲーム書き出しでは runtime と engine だけを同梱する (`player/`)。

## データモデル (core/types.ts)

- `ProjectData` … 複数の `SceneData`、開始シーン、(将来) アセット・Prefab
- `SceneData` … `entities` (ID → EntityData)、`roots` (ルートの並び順)、環境設定、編集カメラ、視点ブックマーク、プレイヤー
- `EntityData` … 名前・種類・親子 (`parent` / `children`)・表示・ロック・Transform (回転は度数法)・
  種類別データ (`mesh` / `light` / `camera`)・`components` (ゲームロジック)
- 保存形式には `format` と `version` を持たせ、`core/serialization.ts` で検証・修復・移行する。
  壊れた親子関係や欠けた値は読み込み時に修復される。

## Undo / Redo (core/History.ts, core/commands.ts)

| コマンド | 用途 |
| --- | --- |
| `AddEntitiesCommand` | 追加・複製・貼り付け |
| `RemoveEntitiesCommand` | 削除 (サブツリーごと。元の位置に戻せる) |
| `UpdateEntitiesCommand` | 名前・色・数値などの属性変更。`mergeKey` が同じ連続変更は1回にまとめる |
| `SetTransformsCommand` | ギズモ・ドラッグ移動の確定 (操作中はデータを直接更新し、離したときに確定) |
| `SnapshotCommand` | 親子付け・グループ化など構造の変更 (前後のシーン全体を保持) |
| `LambdaCommand` | シーン設定など任意の変更 |

履歴はシーンごとに保持し、上限は 100 件。

## ビューポートとタッチ入力 (engine/)

- `EditorViewport` … 描画ループ (必要な時だけ描画)、選択枠、ピック、フォーカス、サムネイル
- `ViewportInput` … タッチ/マウスを状態機械で解釈する
  - 1本指: タップ選択 / ギズモ / 選択物の直接ドラッグ / カメラ回転 / 長押しメニュー / ダブルタップでフォーカス
  - 2本指: 平行移動・ピンチズーム・ひねり回転 (1本指操作中に2本目が触れたら操作を取り消す)
- `GizmoController` … Three.js の TransformControls を DOM に接続せずに使い、入力を明示的に渡す。
  複数選択時は中心の「ピボット」を動かし、その変化量を全員に適用する。
  中央付近のハンドルと選択物が重なる場合は、指で扱いやすい直接ドラッグを優先する。

## Play Mode (runtime/, app/PlayController.ts)

1. Play を押すとプロジェクトを丸ごと複製し、`GameRuntime` に渡す (エディタの描画と入力は停止)
2. `GameRuntime` は独立した Three.js シーンを構築し、コンポーネントを毎フレーム実行する
3. Stop で破棄してエディタに戻る。エディタのデータには触れていないので自動的に元に戻る
4. 設定「Play 終了時: 変化を保存する」の場合のみ、位置などの変化を Undo 可能な形で反映する

コンポーネントでエラーが起きた場合は、そのコンポーネントだけを停止し、
「Play / オブジェクト名」の形でエラー発生箇所をログに残す (`core/logger.ts`)。

### ゲームの仕組み (Phase 3)

```
GameRuntime ─┬─ GameState     スコア・お金・HP・残機・持ち物・変数・時間 (DOM 非依存・単体テスト対象)
             ├─ AudioEngine   Web Audio。組み込みの効果音・音楽は合成、音声アセットはデコードして再生
             ├─ GameUI        HUD・シーンの UI 要素・ジャンプ/アクションボタン・会話・各画面 (DOM)
             ├─ RuntimeInput  ジョイスティック・視点・キーボード・ジャンプ/アクションの入力キュー
             └─ PhysicsWorld  プレイヤー・敵には自動で「動く」ボディ、その他のメッシュは自動で固定の当たり判定
```

- HP・ダメージ・倒れたとき (スコア加算 / 残機を減らして復活 / ゲームオーバー) はランタイムが一元管理し、
  コンポーネントは `runtime.damage()` などの API (`RuntimeAPI`) を呼ぶだけにしている
- 「拾う・触れる」は見た目の箱 (Box3) の重なりで判定するため、物理 OFF のシーンでも動く
- 会話・メニュー・タイトル・終了画面の表示中はゲームの進行 (時間・コンポーネント・物理) を止める (`frozen`)
- ゲーム内の出来事は `runtime.emit(event, entityId)` で通知される (Phase 4 のイベントシステムの入口)
- 「もう一度」「タイトルへ」はランタイムを作り直す (`PlayController.restart`)。セーブデータは `localStorage` の
  `pocket-engine:save:<プロジェクトID>` に保存し、タイトル画面の「つづきから」で読み込む

### イベント (Phase 4)

- データ: `SceneData.events: EventRule[]` (いつ = `trigger`、もし = `conditions`、なら = `actions`、ちがえば = `elseActions`)、
  `ProjectData.variables: VariableDef[]`。どれも「種類 + パラメータ」の `EventBlock` で表す (`core/events.ts`)
- 各ブロックの定義 (`BlockDef`) にパラメータの型を書いておくと、エディタの入力欄と文章の要約が自動で作られる
- 実行: `runtime/EventSystem.ts`。ゲーム本体とは `EventHost` だけでやり取りするので単体テストできる
  - 時間・触れた・条件のトリガーは毎フレーム判定 (変化した瞬間だけ発火)、拾った・倒した などは `runtime.emit` から受け取る
  - 「待つ」「会話」は実行を一時停止して次のフレーム以降に再開。1 フレームの動作数に上限を設けて無限ループを防ぐ
  - 知らない種類 (新しいバージョンのデータ) は読み込み時に残し、実行時は無視する
- シーン切り替えは `PlayController` がランタイムを作り直し、`GameState` を引き継ぐ

### アニメーション・パーティクル (Phase 5)

- キーフレーム: `core/animation.ts` (クリップ = 時刻付きのローカルのトランスフォーム)。コンポーネント「アニメーション」の
  props に保存し、Inspector の専用エディタ (`ui/panels/animEditor.ts`) で編集。3D ビューのプレビューは
  `EditorViewport.previewPose()` でデータを変えずに見た目だけ動かす
- キャラクターの動き: 当たり判定を持つオブジェクト (Group) ではなく、その中のメッシュ (`userData.content`) だけを動かす
- パーティクル: `engine/particles.ts`。粒は CPU で動かし 1 回の `Points` で描画 (独自シェーダーで粒ごとの大きさ・色)。
  ワールド座標で動かすのでシーンの直下に置く。エディタでは `EffectPreview` が選択中の発生源を動かす
- コンポーネント同士・イベントからの操作は `runtime.registerController / getController` (アニメーション・パーティクル)

### アセット・部品 (Phase 6)

- アセットの本体 (Blob) は IndexedDB の `assets` ストア、一覧用の情報 (`AssetEntry`: 種類・フォルダ・小さな画像・
  モデルの大きさ / アニメーション名 / 画像の大きさ / 音声の長さ) はプロジェクトの JSON に保存。取り込みと削除は `app/AssetService.ts`
  (削除時はプロジェクト内の参照を外す)。フォルダはアセットの `folder` と空のフォルダ用の `ProjectData.assetFolders`
- 3D モデル: `engine/models.ts`。GLTFLoader / SkeletonUtils は動的 import (別チャンク)。同じアセットは 1 回だけ読み込んで
  複製し (ジオメトリ・マテリアルは共有、`userData.sharedModel` で破棄対象から除外)、スキンメッシュは骨ごと複製。
  エンティティは `kind: 'model'` + `EntityData.model` (アセット ID・大きさ・中心・再生するアニメーション)。
  `SceneBuilder` は入れ物 (Group) を先に置いて非同期に中身を入れ、読み込むまではワイヤーフレームの箱を表示。
  ランタイムは `SceneBuilder.whenLoaded()` を待ってから開始し、`AnimationMixer` を `'modelAnim'` コントローラとして登録
- 小さな画像: `engine/thumbnail.ts` (画面用のレンダラーで別の描画先に描く。WebGL を増やさない)
- 置く: `core/assetPlacement.ts` (アセット → エンティティ。DOM 非依存)。ドラッグ配置は画面座標 → 地面の点
- 部品 (Prefab): `core/prefabs.ts`。`PrefabEntry` はサブツリーのエンティティをそのまま保存し、置くときに ID を振り直す。
  置いた物は `EntityData.prefab` で部品とつながる。大量配置の位置は決まった乱数 (seed) で計算するので同じ設定なら同じ配置

### 地形・空・画面の効果 (Phase 7)

- 地形: `core/terrain.ts` (高さの格子・生成・ブラシ。DOM 非依存)、`engine/terrainMesh.ts` (格子のメッシュ・
  高さと傾きによる頂点カラー・光線との交点を格子を進んで求める)、`engine/TerrainBrush.ts` (ブラシ編集)。
  ブラシは `ViewportInput.tool` として 1 本指のドラッグを受け持ち、なぞっている間は作業用のコピーで見た目だけ更新、
  指を離したら `setEntityValue('terrain.heights')` で 1 回の Undo にする。物理は cannon-es の `Heightfield`
  (`colliderShapes.terrainHeightfield`。XY 平面の格子を X 軸で -90° 回すため行の順番を逆にする)
- 時刻: `engine/sky.ts` (時刻 → 太陽の方向・空の色・明るさ、星・月・雲・稲妻のオブジェクト)。
  `SceneEnvironment` が太陽光 (DirectionalLight) の向き・色・明るさをデータを変えずに上書きする
  (元の値は `light.userData.baseIntensity / baseColor`)。Play 中の時刻は `GameRuntime.setHour()` で進め、
  空の画像 (PMREM) の作り直しは画質に応じて間引く
- 画面の効果: `engine/PostProcessor.ts` (EffectComposer を動的 import)。`EngineRenderer.setPost()` で
  描画する側 (エディタ / ランタイム) が毎フレーム設定し、低画質では使わない。
  順番は 描画 → 被写界深度 → ブルーム → OutputPass (トーンマッピング・sRGB) → 色あい・周辺減光

### デバッグ・カメラ・タイムライン (Phase 8)

- ログ: `core/logger.ts`。エントリーに `entityId` (原因のオブジェクト) と通し番号を持ち、未読のエラー数を数える。
  ランタイムのエラー (`GameRuntime.report`) はオブジェクトの ID 付きで記録し、コンソール (`ui/DebugConsole.ts`) から選べる
- 性能: `engine/PerfMonitor.ts` (requestAnimationFrame を数える。エディタは変化があるときだけ描画するため)、
  描画の情報は `renderer.info`
- カメラ: エディタは `EditorViewport.setPreviewCamera()` でシーンのカメラの視点を表示 (タップ・カメラ操作で戻る)。
  ランタイムは `GameRuntime.switchCamera()` と `BlendCameraRig` (指定秒数でなめらかに切り替え、その後は対象のカメラに追従)
- タイムライン: `core/timeline.ts` (データ = 時刻付きのイベントの動作)、`runtime/TimelinePlayer.ts` (時刻になった動作を
  `EventSystem.runActions()` で実行するので、待つ・会話もイベントと同じ)。会話などでゲームが止まっている間は進まない。
  再生中はプレイヤーの入力を止め (`GameRuntime.input` が空の入力を返す)、GameUI に黒帯とスキップボタンを出す

### データの管理 (Phase 9)

- ZIP: `core/zip.ts` (依存なしの作成・読み込み。圧縮はブラウザの `CompressionStream('deflate-raw')` があれば使う。
  CRC-32 で中身を確かめる)。Phase 10 のゲームの書き出しでも使う
- パッケージ: `core/projectPackage.ts` (`pocket-package.json` + `project.json` + `assets/<ID>`。複数のプロジェクトは
  `projects/<ID>/` のフォルダ)。読み込むと新しい ID のプロジェクトとして追加する
- バックアップ: `storage/BackupStore.ts` (IndexedDB の `backups` ストア、キーは「プロジェクト ID:時刻」)。
  `ProjectService.save()` の後に自動バックアップ (10 分ごと)、古い自動バックアップから消して最大 12 個
- 保存領域: `navigator.storage.estimate()` / `persist()`
- 他のプロジェクトから取り込む: `AssetService.importFromProject()` (部品の中のアセットの参照をたどって一緒に取り込み、
  ID が重なるものは付け替えて部品の中の参照も置き換える)

### ゲームの書き出し (Phase 10)

- 書き出したゲームの本体: `player/main.ts` → `player/StandalonePlayer.ts`。`runtime/` と `engine/` だけを使い、
  エディタ (`ui/` のパネル・`app/`) は含まない。`vite.player.config.ts` で **1 つの IIFE** (`dist/player/pocket-player.js`、
  CSS も埋め込み、動的 import もまとめる) にビルドするので `<script src>` でも file:// でも動く
- データ: `game-data.js` = `window.__POCKET_GAME__ = { format, version, project, assets: { ID: { mime, base64 } } }`。
  `core/gameExport.ts` が作る (`</script>` や U+2028 で壊れない JSON)。プレイヤーはアセットを必要になったときに Blob にする
- 書き出し: `app/GameExporter.ts` がエディタと同じ場所の `player/pocket-player.js` を読み込み、アセットの本体とアイコン
  (Canvas で 192 / 512 の PNG) を集めて、`core/gameExport.ts` で ZIP (`index.html` + 本体 + データ + manifest + `.nojekyll`)
  または 1 つの HTML にする。開発サーバーではプレイヤーを求められたときにその場でビルドする (`vite.config.ts` のプラグイン)
- `GameRuntime` に `extraSettings` / `extraTitle` (設定画面・タイトル画面に足す項目) と `setQuality()` を追加。
  プレイヤーが画質 (自動 / 低 / 中 / 高) と全画面 (`runtime/fullscreen.ts`、webkit 付きにも対応) を足す
- 画面の向き: `GameSettings.orientation`。スマホで合わなければ案内、PC で縦向きのゲームは縦長の枠

## コンポーネント (components/)

`registerComponent()` で定義を登録すると、Inspector の UI (プロパティの種類から自動生成) と
Play Mode の実行の両方に反映される。Phase 2 以降の Rigidbody / Collider / Trigger / プレイヤー操作 /
スクリプトもこの仕組みで追加する想定。

```ts
registerComponent({
  type: 'rotator',
  label: '自動回転',
  schema: [{ key: 'speed', label: '回転速度 (度/秒)', type: 'vec3' }],
  defaults: () => ({ speed: [0, 90, 0] }),
  create(ctx, props) {
    return { update(dt) { ctx.object.rotation.y += ... } };
  },
});
```

## 保存 (storage/, app/ProjectService.ts)

- IndexedDB (`pocket-engine` DB): `projects` (本体)、`meta` (一覧用の軽量情報 + サムネイル)、`assets` (読み込んだファイルの本体)、`backups` (自動 / 手動バックアップ)
- IndexedDB が使えなければ localStorage、それも無理ならメモリ (警告を表示)
- 変更の 2.5 秒後に自動保存。タブが裏に回ったとき (`visibilitychange` / `pagehide`) にも保存
- エディタ設定 (グリッド・スナップなど) はプロジェクトとは別に localStorage に保存

## UI (ui/)

- UI フレームワークは使わず、小さな DOM ヘルパー (`ui/dom.ts`) とクラスで構成
- パネルは Editor のイベントを購読し、構造が変わったときだけ再構築、値の変化は部分更新
- スマホ向けの工夫: 44px 以上のタッチターゲット、専用テンキー (iOS の数字キーボードにマイナスが無い問題の回避)、
  ボトムシート、ゴーストクリック対策、ホバー表現はホバー可能な端末のみ、セーフエリア対応

## 今後の拡張ポイント

| フェーズ | 追加場所 |
| --- | --- |
| 書き出し先の追加 (itch.io など) | `core/gameExport.ts` のファイル一覧・`app/GameExporter.ts` |
