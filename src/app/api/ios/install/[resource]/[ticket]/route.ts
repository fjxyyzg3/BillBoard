import { serveIosInstall } from "@/lib/ios-install";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ resource: string; ticket: string }> }) {
  const { resource, ticket } = await context.params;
  return serveIosInstall(request, resource, ticket);
}

export const HEAD = GET;
