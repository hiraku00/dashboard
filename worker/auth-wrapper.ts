import app from "../dist/server/index.js";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await app.fetch(request, env, ctx);
    if (!request.headers.get("accept")?.includes("text/html")) return response;
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store, max-age=0, must-revalidate");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default worker;
