# PROJECT_HEMO_STATUS.md

最終更新: 2026-10-13 / 現在のフェーズ: **Phase 1（実験室とカメラ）実装済み・CI成功**
作業ブランチ: `claude/hemo-phase1`（mainは未変更。マージはユーザー確認後）

## Phase 1 で実施したこと
- 起動: `?mode=hemo`（または `#hemo`）で HEMO を起動。通常の `./` は従来どおり（E2Eで確認）。
- 追加ファイル: `src/hemo/{lab,LabScene,HemoCameraInput,HemoApp,boot}.ts`, `src/hemo/hemo.css`, `tests/hemo.test.ts`(6件), `e2e/hemo-phase1.spec.ts`(4件)
- 変更ファイル: `src/main.ts`（起動分岐の追加のみ）
- 流用: `EngineRenderer`（描画）、`EditorCamera`（オービット/パン/ズーム/フォーカス）、`ui/dom.ts`、既存CSS変数
- 機能: 床・壁3面・照明・影、選択/移動できる物5個、1本指回転・2本指パン+ピンチ・ホイール・右ドラッグ、
  選択中の物の上から始めたドラッグは物を移動（それ以外はカメラ＝競合しない）、タップ選択、ダブルタップでフォーカス、
  リセット/フォーカス/視点リセット、FPS表示、メニュー（通常エディタへ戻る）。キーボード: R/F/Esc。

## Phase 1 のテスト結果（GitHub Actions: CI, ブランチ claude/hemo-phase1）
- 型チェック・単体テスト・ビルド・E2E（既存＋HEMO新規）すべて成功。
- 注意: 実機iPhone Safariでの確認、見た目（スクリーンショット）の確認は**未実施**。E2Eは合成ポインター操作で検証。
- 注意: 公開URL（GitHub Pages）での確認は未実施（main へマージ後の deploy.yml が行う）。
- この環境からは npm レジストリに接続できないため、ローカル実行は不可。検証は CI 経由。
  CIログ本体は取得不可だが、check-runs の annotations で型エラーは読める。

## 既知の制約・未完了
- 再生/一時停止/スロー、時間倍率、ボトムシートの操作パネルは未実装（Phase 3, 5）。
- 保存状態表示は「未保存」固定（Phase 5で実装）。
- 物は見た目のみ（物理なし）。人体モデルなし（Phase 2）。

## 次に実施すること
1. ユーザーが実機で `…/?mode=hemo` を確認 → 問題なければ PR 作成・main へマージ。
2. Phase 2: 仮の人型モデル（プロシージャルな骨格）＋GLB差し替え層。
3. Phase 3: `PhysicsWorld` にジョイント追加 → ラグドール。

---
# 以下は Phase 0 の調査記録

## 実施した変更
- コード変更なし。ZIP を `/home/claude/orig/xxx-main/` に展開して読んだだけ（元ファイルは無改変）。

## 実行したテストと結果
- **未実行**。`npm ci` が失敗（`registry.npmjs.org` への接続が組織の egress ポリシーで 403 拒否）。
  型チェック・単体テスト・ビルド・E2E はすべて「実行していない」。
- 過去報告（121 単体 / 61 E2E）と、今回の ZIP を grep で数えた `it()/test()` 数（単体 130 / E2E 68）は一致しない。
  差の理由は未確認（その後のフェーズで増えた可能性）。実行結果ではなく宣言数。

## 現状の把握（コードから確認した事実）
- スタック: TypeScript + Vite 8 + Three.js 0.186 + cannon-es 0.20、Vitest、Playwright。UI フレームワーク無し（自前 DOM）。
- `vite.config.ts` の `base: './'`（GitHub Pages のサブパス対応）。CI は `.github/workflows/ci.yml`、公開は `deploy.yml`（公開 URL のスモークテスト付き）。
- データ駆動: 編集データはプレーン JSON（`core/types.ts`）、変更は Command 経由、Play は JSON 複製を `GameRuntime` が実行。

## 流用判断表
| 項目 | 判断 | 根拠 |
| --- | --- | --- |
| 3D 描画 | 既存のまま | `engine/EngineRenderer.ts`, `SceneBuilder.ts`（EntityData→Object3D）、影・PMREM・ポスト処理あり |
| カメラ | 既存のまま（拡張少） | `engine/EditorCamera.ts`（オービット）、`ViewportInput.ts`（1本指回転/2本指パン・ピンチ/PC マウス）。`runtime/cameraRigs.ts`（Play 用） |
| 物理演算 | 拡張 | `runtime/PhysicsWorld.ts`（cannon-es、固定 1/60 ステップ、solver 8 回、SAP、Box/Sphere/Cylinder/Capsule(=球2+円柱)/Heightfield、Rigidbody/Collider コンポーネント）。**ジョイント/コンストレイント API は未実装** |
| 関節・ラグドール | **新規（PhysicsWorld を拡張）** | `Constraint`/`ragdoll` の記述はコード内に一切無い。cannon-es 自体は ConeTwist / Hinge / PointToPoint / Lock 制約を持つので**新ライブラリ不要** |
| コンポーネント追加 | 既存のまま | `components/registry.ts` の `registerComponent()` で Inspector UI と Play 実行に自動反映 |
| アニメーション/スキニング | 既存のまま（要検証） | `engine/models.ts`（GLTFLoader、`SkeletonUtils.clone` で骨ごと複製）、`GameRuntime` が `AnimationMixer` を使う。**骨⇔物理ボディの連動は無い** |
| パーティクル | 拡張 | `engine/particles.ts`（CPU 更新 1 Points、画質別上限 150/400/900、加算/通常ブレンド）。粒⇔床の衝突・着地後の痕は無い（重力と寿命のみ） |
| 血痕デカール | **新規** | デカール関連コードは存在しない（grep 確認）。粒子→着地で床/壁にデカール生成、重なり・経年変化は新規 |
| マテリアル/テクスチャ | 既存＋拡張 | `engine/materials.ts`, `textures.ts`（手続きテクスチャ・画像・透明度）。肌/髪向けの専用シェーダは無い |
| アセット読込 | 既存のまま | `app/AssetService.ts`（GLB/gltf/画像/音声、IndexedDB 保存） |
| 保存 | 既存＋独立データ | `storage/ProjectRepository.ts`（IndexedDB→localStorage→メモリ）、`BackupStore`。HEMO 設定は `ProjectData` に混ぜず別構造を推奨 |
| UI | 既存＋HEMO 専用 | `ui/BottomSheet.ts`, `TopBar.ts`, `ToolBar.ts`, `PlayHUD.ts` を再利用。縦画面の再生コントロール・時間倍率は新規 |
| 時間倍率/スロー | 新規（小） | `GameRuntime` のステップ `dt` にスケールを掛ける形で実現可（`physics.step(dt)` は GameRuntime:777） |
| 公開/テスト | 既存のまま | CI・deploy・E2E（iPhone 13 風 + Desktop）あり |

## 不足機能・リスク一覧
1. **依存関係をインストールできない環境**（今回）。テスト/ビルド検証ができない → 実装は可能だが検証は不可。要: npm レジストリに届く環境（GitHub Actions の CI で代替可能）。
2. **ラグドール**: PhysicsWorld に制約管理・ボーン⇔ボディ同期が必要。見た目メッシュとコライダー分離の方針に合う（ボーンごとに Capsule ボディ→ボーンへ姿勢反映）。
3. **人体モデル**: リポジトリに人体 GLB は無い。当面は仮モデル（プロシージャルな人型＝カプセル/球の骨格）で進め、GLB 差し替え可能なボーン名マッピング層を作る。
4. **血液表現のモバイル性能**: デカールの枚数上限・プール再利用・画質別上限が必須（既存 `MAX_PARTICLES` と同じ思想）。
5. **cannon-es の精度/安定性**: 多関節は solver 反復を増やす必要（現状 8）。スマホ負荷とのトレードオフ。HEMO 専用ワールドでは反復や sub-step を別設定にする。
6. `GameRuntime.ts` が 1533 行と大きい。大改造は避け、HEMO は別ランタイム（独立クラス）から `SceneBuilder`/`EngineRenderer`/`PhysicsWorld` を呼ぶ形が安全。
7. 表現方針: 架空のゲーム内の視覚表現。「医学的に正確」とは表現しない（指示書 第7章）。

## 推奨設計
- 新規ディレクトリ `src/hemo/`（`HemoApp`, `LabScene`, `HumanoidModel`, `RagdollPhysics`, `BloodFx`, `ExperimentState`, `ui/`）。既存 `src/` への変更は `main.ts` の起動切替（URL `?mode=hemo` 等）と `PhysicsWorld` の最小拡張のみ。
- 通常の Pocket Engine は無改変で動く状態を維持（回帰テスト対象）。
- HEMO の保存は別 IndexedDB ストア/別キー（既存プロジェクト形式に混在させない）。

## 推奨開発順序と完了条件
1. （要環境）`npm ci` → typecheck / test / build / e2e のベースライン取得。
2. Phase 1 実験室＋自由カメラ（`EditorCamera` 再利用、床・壁・照明）。
3. Phase 2 仮人体モデル＋GLB 差し替え層、アニメ再生。
4. Phase 3 `PhysicsWorld` にジョイント追加→ラグドール、停止/再開/リセット/時間倍率。
5. Phase 4 粒子＋デカール（上限・画質連動）。
6. Phase 5 実験ツール/保存/FPS 表示。
7. Phase 6 最適化・回帰・Pages ビルド。

## 既知の不具合
- 不明（テスト未実行）。

## 未完了の作業
- Phase 1 以降すべて。ベースラインのテスト/ビルド確認。

## 次に実施すべきこと
- npm レジストリへ接続できる環境で、`npm ci && npm run typecheck && npm test && npm run build` を確認（ローカル PC か GitHub Actions）。
- 環境が用意できない場合でも、Phase 1 の実装は可能（ただし検証不能のまま積むリスクあり）。
