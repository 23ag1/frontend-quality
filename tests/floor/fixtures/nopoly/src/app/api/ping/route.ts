// A route handler runs on the server's Node, not in the browser: not the floor.
export async function GET() {
  const okServerRoute = AbortSignal.any([AbortSignal.timeout(1000)]);
  return new Response(String(okServerRoute.aborted));
}
