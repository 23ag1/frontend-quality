// A feature that goes around the network layer.
export async function loadOrders() {
  const badRawFetch = await fetch("/api/orders", { signal: AbortSignal.timeout(5000) });
  // const okCommentedFetch = await fetch("/x");
  return badRawFetch.json();
}
