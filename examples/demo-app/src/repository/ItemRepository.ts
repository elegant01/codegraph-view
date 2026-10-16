import { log } from '../lib/logger.ts';

export interface Item {
  id: number;
  name: string;
  status: 'pending' | 'passed' | 'rejected' | 'deleted';
}

// 数据层：示例里用内存 Map 代替真实存储
export class ItemRepository {
  private rows: Map<number, Item> = new Map([
    [1, { id: 1, name: 'first item', status: 'pending' }],
    [2, { id: 2, name: 'second item', status: 'passed' }],
  ]);

  findById(id: number): Item | null {
    return this.rows.get(id) ?? null;
  }

  findAll(): Item[] {
    return [...this.rows.values()];
  }

  searchByKeyword(keyword: string): Item[] {
    log(`search by keyword: ${keyword}`);
    return this.findAll().filter((row) => row.name.includes(keyword));
  }

  markStatus(id: number, status: Item['status']): Item | null {
    const row = this.findById(id);
    if (!row) return null;
    const next: Item = { ...row, status };
    this.rows.set(id, next);
    return next;
  }
}
