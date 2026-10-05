// Sets --app-h for engines without dvh; the CSS uses var(--app-h, 100dvh).
export function installAppHeight() {
  if (window.CSS && CSS.supports("height", "1dvh")) return;
  document.documentElement.style.setProperty("--app-h", window.innerHeight + "px");
}
