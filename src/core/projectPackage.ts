import { sanitizeProject } from './serialization';
import type { ProjectData } from './types';
import { bytesText, createZip, isZip, readZip, textBytes } from './zip';
import type { ZipEntry } from './zip';

/**
 * プロジェクトのパッケージ (.pocket.zip)。プロジェクトのデータとアセットのファイル本体をまとめる。
 * 1 つのプロジェクトでも、すべてのプロジェクトのバックアップ (複数) でも同じ形式:
 *
 *   pocket-package.json            { format, version, projects: ['', ...] }  (各プロジェクトのフォルダ)
 *   <フォルダ>project.json          プロジェクトのデータ
 *   <フォルダ>assets/<アセット ID>   アセットのファイル本体
 *
 * 1 つのときはフォルダが ''、複数のときは 'projects/<ID>/'。
 */

export const PACKAGE_MANIFEST = 'pocket-package.json';
export const PACKAGE_FORMAT = 'pocket-engine-package';

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  version: 1;
  exportedAt: number;
  projects: string[];
}

export interface PackagedProject {
  project: ProjectData;
  /** アセット ID → ファイル本体 */
  assets: Map<string, Uint8Array>;
}

/** アセットのファイル本体を取り出す関数 (無ければ null) */
export type AssetReader = (projectId: string, assetId: string) => Promise<Uint8Array | null>;

async function entriesFor(project: ProjectData, prefix: string, read: AssetReader, missing: string[]): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [{ name: `${prefix}project.json`, data: textBytes(JSON.stringify(project)) }];
  for (const a of project.assets) {
    const data = await read(project.id, a.id);
    if (data) out.push({ name: `${prefix}assets/${a.id}`, data });
    else missing.push(`${project.name} / ${a.name}`);
  }
  return out;
}

/** プロジェクト (1 つ以上) をパッケージにする。missing に本体が見つからなかったアセットの名前が入る */
export async function buildPackage(projects: ProjectData[], read: AssetReader, missing: string[] = []): Promise<Uint8Array> {
  if (projects.length === 0) throw new Error('書き出すプロジェクトがありません');
  const single = projects.length === 1;
  const prefixes = projects.map((p) => (single ? '' : `projects/${p.id}/`));
  const manifest: PackageManifest = { format: PACKAGE_FORMAT, version: 1, exportedAt: Date.now(), projects: prefixes };
  const entries: ZipEntry[] = [{ name: PACKAGE_MANIFEST, data: textBytes(JSON.stringify(manifest, null, 2)) }];
  for (let i = 0; i < projects.length; i++) entries.push(...(await entriesFor(projects[i], prefixes[i], read, missing)));
  return createZip(entries);
}

/** パッケージを読む (プロジェクトのデータは修復済み。ID はそのまま) */
export async function readPackage(data: Uint8Array): Promise<PackagedProject[]> {
  if (!isZip(data)) throw new Error('Pocket Engine のパッケージ (.zip) ではありません');
  const files = await readZip(data);
  const manifestBytes = files.get(PACKAGE_MANIFEST);
  let prefixes: string[];
  if (manifestBytes) {
    const m = JSON.parse(bytesText(manifestBytes)) as Partial<PackageManifest>;
    if (m.format !== PACKAGE_FORMAT) throw new Error('Pocket Engine のパッケージではありません');
    prefixes = Array.isArray(m.projects) ? m.projects.filter((x): x is string => typeof x === 'string') : [''];
  } else if (files.has('project.json')) {
    prefixes = [''];
  } else {
    throw new Error('パッケージの中にプロジェクトが見つかりません');
  }
  const out: PackagedProject[] = [];
  for (const prefix of prefixes) {
    const json = files.get(`${prefix}project.json`);
    if (!json) continue;
    const project = sanitizeProject(JSON.parse(bytesText(json)));
    const assets = new Map<string, Uint8Array>();
    for (const a of project.assets) {
      const body = files.get(`${prefix}assets/${a.id}`);
      if (body) assets.set(a.id, body);
    }
    out.push({ project, assets });
  }
  if (out.length === 0) throw new Error('パッケージの中にプロジェクトが見つかりません');
  return out;
}
