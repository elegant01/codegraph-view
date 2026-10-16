import { warn } from './logger.ts';

export interface ItemLike {
  id: number;
  name: string;
}

// 工具层：格式化，示例用
export function formatItem(item: ItemLike): string {
  return `#${item.id} ${item.name}`;
}

export function formatItemList(items: ItemLike[]): string {
  if (items.length === 0) {
    warn('empty item list');
    return '(empty)';
  }
  return items.map(formatItem).join(', ');
}
