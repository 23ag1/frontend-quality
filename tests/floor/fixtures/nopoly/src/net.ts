export function request(url: string, userSignal: AbortSignal) {
  const blockAny = AbortSignal.any([userSignal, AbortSignal.timeout(10000)]);
  return fetch(url, { signal: blockAny });
}

export function guarded(url: string, userSignal: AbortSignal) {
  const flagGuarded = typeof AbortSignal.any === "function"
    ? AbortSignal.any([userSignal])
    : userSignal;
  return fetch(url, { signal: flagGuarded });
}
