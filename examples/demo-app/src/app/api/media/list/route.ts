import { ItemService } from '../../../../service/ItemService.ts';

const service = new ItemService();

// GET /api/media/list?q=xxx —— 列出数据
export async function GET(request: Request): Promise<Response> {
  const keyword = new URL(request.url).searchParams.get('q') ?? '';
  const rows = service.getItemList(keyword);
  const text = service.describeItemList(keyword);
  return new Response(JSON.stringify({ data: rows, text }), { status: 200 });
}
