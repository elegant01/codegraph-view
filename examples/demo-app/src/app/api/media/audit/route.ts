import { ItemService } from '../../../../service/ItemService.ts';

const service = new ItemService();

// POST /api/media/audit —— 审核一条数据
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as { id: number; pass: boolean };
  const item = service.auditItem(body.id, body.pass);
  if (!item) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  return new Response(JSON.stringify({ data: item }), { status: 200 });
}
