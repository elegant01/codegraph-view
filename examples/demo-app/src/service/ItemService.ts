import { ItemRepository, type Item } from '../repository/ItemRepository.ts';
import { formatItem, formatItemList } from '../lib/format.ts';
import { log } from '../lib/logger.ts';

// 业务层：示例里的核心逻辑
export class ItemService {
  private repository = new ItemRepository();

  getItemList(keyword: string): Item[] {
    log(`get item list: ${keyword}`);
    const rows = this.repository.searchByKeyword(keyword);
    return this.filterVisible(rows);
  }

  describeItemList(keyword: string): string {
    const rows = this.getItemList(keyword);
    return formatItemList(rows);
  }

  auditItem(id: number, pass: boolean): Item | null {
    const item = this.repository.findById(id);
    if (!item) return null;
    log(`audit item ${formatItem(item)} -> ${pass ? 'passed' : 'rejected'}`);
    return this.repository.markStatus(id, pass ? 'passed' : 'rejected');
  }

  removeItem(id: number): Item | null {
    return this.repository.markStatus(id, 'deleted');
  }

  private filterVisible(rows: Item[]): Item[] {
    return rows.filter((row) => row.status !== 'deleted');
  }
}
