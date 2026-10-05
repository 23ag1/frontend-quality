export function Type() {
  return (
    <div>
      <p className="bad-text-xs text-xs">caption</p>
      <p className="bad-text-sm text-sm/6">hint</p>
      <p className="bad-arbitrary text-[11px]">tiny</p>
      <p className="ok-text-base text-base">body</p>
      <p className="ok-sm-breakpoint sm:text-lg">large on tablets</p>
      <code className="bad-font-mono font-mono">A-12</code>
      <span className="ok-tabular tabular-nums">12:30</span>
      <div className="bad-safe-area pb-[env(safe-area-inset-bottom)]" />
    </div>
  );
}
