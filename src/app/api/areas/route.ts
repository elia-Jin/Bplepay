import { requestArea } from "@/lib/areas";
import { errorMessage } from "@/lib/types";

/** 구획 조회 + 수집 요청 */
export async function POST(request: Request) {
  try {
    const { name } = (await request.json()) as { name?: string };
    const area = await requestArea(name ?? "");
    return Response.json({ area });
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 400 });
  }
}
