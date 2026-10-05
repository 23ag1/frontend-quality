export function Panel({ a, b }: { a: Set<string>; b: Set<string> }) {
  const blockSetUnion = a.union(b);
  const okSchema = z.union([z.string(), z.number()]);
  const blockFindLast = [1, 2, 3].findLast((n) => n > 1);
  return (
    <div className="ok-covered h-dvh">
      <div className="block-tw-dvh h-[40dvh]" />
      <div className="ok-tw-supports supports-[height:1dvh]:h-[50dvh]" />
      {String(blockSetUnion)}{String(okSchema)}{blockFindLast}
    </div>
  );
}
