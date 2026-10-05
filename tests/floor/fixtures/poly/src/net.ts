export function request(url: string, userSignal: AbortSignal) {
  const okPolyfilledAny = AbortSignal.any([userSignal, AbortSignal.timeout(10000)]);
  return fetch(url, { signal: okPolyfilledAny });
}

export function guarded(url: string, userSignal: AbortSignal) {
  const flagGuarded = typeof AbortSignal.any === "function"
    ? AbortSignal.any([userSignal])
    : userSignal;
  return fetch(url, { signal: flagGuarded });
}
