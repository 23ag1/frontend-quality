export function Colors() {
  return (
    <section>
      <div className="bad-hex3 bg-[#fff]" />
      <svg><path className="bad-hex8" fill="#00000080" /></svg>
      <div className="bad-hex6" style={{ color: "#1a2b3c" }} />
      <p className="ok-order-number">Order #123 is ready</p>
      <a className="ok-anchor" href="#add">Jump</a>
      <svg><rect className="ok-url-ref" fill="url(#abc)" /></svg>
      <div className="bad-palette bg-blue-500 text-white" />
      <div className="bad-palette-variant hover:text-red-600" />
      <div className="ok-role bg-accent text-ink" />
    </section>
  );
}
