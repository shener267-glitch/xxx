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
5. **runtime はエディタに依存しない**: Phase 6 のゲーム書き出しでは runtime だけを同梱すればよい。

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

- IndexedDB (`pocket-engine` DB): `projects` (本体)、`meta` (一覧用の軽量情報 + サムネイル)、`assets` (Phase 5 用に予約)
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
| イベント | `SceneData` にイベント定義、ランタイムに条件評価器 (`runtime.emit` / `eventListeners` を入口にする) |
| アセット・Prefab | `ProjectData.assets / prefabs` と IndexedDB の `assets` ストア |
| 書き出し | `runtime/` のみを含むプレイヤー用エントリーポイント + ZIP 生成 |
