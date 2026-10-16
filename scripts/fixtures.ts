// fixture 项目列表的读取（e2e / diag 两个脚本共用）
//
// 优先级：scripts/fixtures.local.json（本地私有用，已 gitignore）
//       → scripts/fixtures.example.json（随仓库分发的占位示例）
// 本地怎么配：把 example 复制成 fixtures.local.json，填自己项目的根目录即可。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Fixture { name: string; root: string; port: number }

const LOCAL = fileURLToPath(new URL('./fixtures.local.json', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('./fixtures.example.json', import.meta.url));

export function loadFixtures(): Fixture[] {
  const file = existsSync(LOCAL) ? LOCAL : EXAMPLE;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file} 应是 fixture 数组`);
  return raw.map((item: unknown, i: number): Fixture => {
    const row = item as Partial<Fixture>;
    if (typeof row.name !== 'string' || typeof row.root !== 'string') {
      throw new Error(`${file} 第 ${i + 1} 项缺 name / root`);
    }
    return { name: row.name, root: row.root, port: typeof row.port === 'number' ? row.port : 5199 + i };
  });
}
