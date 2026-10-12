# Project HEMO 状態

## Phase 1

### 実施した変更
- GitHubリポジトリの現在のPocket Engineを確認し、既存のThree.js描画、SceneBuilder、SceneEnvironment、EditorCamera、ViewportInput、選択処理を流用。
- 新規プロジェクトの初期シーンをHEMO実験室へ変更。
- 床、背面壁、左右の壁、観察プラットフォーム、仮の人体モデル、検査ライト、リムライト、観察カメラを配置。
- 暗い実験室向けの空・霧・色を設定。

### 変更ファイル
- `src/core/project.ts`
- `PROJECT_HEMO_STATUS.md`

### 完了した機能
- 実験室の床・壁・照明
- 既存の自由カメラ、タッチ操作、選択、配置機能のHEMO初期シーンでの利用
- 初期シーンの再生成による実験状態の初期化基盤

### テストと結果
- 初回 `npm run typecheck` はSkyDataとMaterialPatternの型不一致で失敗。修正済み。
- `npm run test` は初期シーンの保存形式と既存テスト用フィールドの差分で一度失敗したが、初期シーンを保存形式に合わせて修正済み。再確認中。
- `npm run typecheck` 成功。
- `npm run build` 成功（editor/player両方）。
- モバイルブラウザ確認済み（390x844、dark、WebGL）。実験室のエンティティと既存のタッチ操作UIを確認。

### 既知の不具合・制約
- 仮モデルはカプセル形状で、リアルな人体モデルではない。
- 物理演算、血液・血痕表現、実験条件UIは未実装。

### 次に実施すべきこと
- Phase 1の型チェック・ビルド・モバイルブラウザ確認。
- Phase 2で人体モデル読み込みと骨格対応を追加。
