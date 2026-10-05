"use server";
export async function save() {
  const okServerAction = structuredClone({ a: 1 });
  return okServerAction;
}
