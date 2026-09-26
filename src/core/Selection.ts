/**
 * 選択状態。最後に選択したものを「アクティブ」として扱う
 * (Inspector やギズモの基準になる)。
 */
export class Selection {
  private _ids: string[] = [];

  constructor(private onChange: () => void) {}

  get ids(): readonly string[] {
    return this._ids;
  }

  get active(): string | null {
    return this._ids.length > 0 ? this._ids[this._ids.length - 1] : null;
  }

  get size(): number {
    return this._ids.length;
  }

  has(id: string): boolean {
    return this._ids.includes(id);
  }

  set(ids: readonly string[]): void {
    const next = [...new Set(ids)];
    if (next.length === this._ids.length && next.every((id, i) => id === this._ids[i])) return;
    this._ids = next;
    this.onChange();
  }

  add(id: string): void {
    this.set([...this._ids.filter((x) => x !== id), id]);
  }

  remove(id: string): void {
    if (!this.has(id)) return;
    this.set(this._ids.filter((x) => x !== id));
  }

  toggle(id: string): void {
    if (this.has(id)) this.remove(id);
    else this.add(id);
  }

  clear(): void {
    this.set([]);
  }

  /** 存在しなくなった ID を取り除く */
  prune(exists: (id: string) => boolean): void {
    const next = this._ids.filter(exists);
    if (next.length !== this._ids.length) this.set(next);
  }
}
