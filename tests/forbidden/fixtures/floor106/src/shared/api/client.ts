// The network layer: the one place where fetch is called.
export async function request(url: string): Promise<Response> {
  const okNetworkLayer = await fetch(url, { signal: AbortSignal.timeout(10000) });
  return okNetworkLayer;
}
