export const viewport = { width: "device-width", viewportFit: "cover" };

export function Layout() {
  return (
    <main className="ok-modern-dvh h-dvh pb-[env(safe-area-inset-bottom)]">
      <div className="ok-modern-calc h-[calc(100dvh-4rem)]" />
      <p className="ok-text-xs-allowed text-xs">caption</p>
      <p className="bad-under-12 text-[10px]">tiny</p>
      <code className="ok-mono-allowed font-mono">A-12</code>
      <div className="bad-palette-block bg-rose-500" />
      <div className="ok-h-screen-redefined h-screen" />
      <div className="ok-min-h-screen-covered min-h-screen" />
      <div className="bad-max-h-screen-modern max-h-screen" />
    </main>
  );
}
