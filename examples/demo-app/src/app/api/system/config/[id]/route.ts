import { ItemService } from '../../../../../service/ItemService.ts';

const service = new ItemService();

// GET /api/system/config/:id —— 动态段示例
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  const item = service.auditItem(id, true);
  return new Response(JSON.stringify({ data: item }), { status: 200 });
}
