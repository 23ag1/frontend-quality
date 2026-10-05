// A sheet: viewport units in class names. 100vh in this comment is not code.
export function Sheet({ open }: { open: boolean }) {
  if (typeof window !== "undefined" && CSS.supports("height", "1dvh")) {
    console.debug("dvh supported");
  }
  return (
    <div className="ok-tw-fallback h-[var(--app-h,100dvh)]">
      <div className="bad-tw-dvh h-[40dvh]" />
      <div className="ok-tw-covered h-dvh flex" />
      <div className="bad-tw-uncovered max-h-svh" />
      <div className="ok-tw-calc-fallback max-h-[calc(var(--app-h,100dvh)*0.5)]" />
      <div className="bad-tw-calc h-[calc(100dvh-4rem)]" />
      <div className="bad-tw-vh max-h-[calc(100vh-32px)]" />
      <div className="ok-tw-supports supports-[height:1dvh]:h-[50dvh]" />
      <div className="bad-h-screen h-screen" />
      <div className="bad-min-h-screen md:min-h-screen" />
      <div className="bad-max-h-screen max-h-screen overflow-auto" />
      <div className="ok-w-screen w-screen" />
      {open ? <span>open</span> : null}
    </div>
  );
}
