// Bring the Figma window to the front, because rasterisation only happens there.
//
// Chromium stops compositing a window that is not in front, and Figma's exportAsync and
// absoluteRenderBounds both wait on rasterisation: in the background they do not return slowly,
// they do not return at all. Everything else — looking a node up, reading properties, building —
// works either way, which is what made this so hard to see. Measured: the same export is 24 ms
// with the window in front and unbounded behind it.
//
// Only the render steps need this. Building does not, so it does not steal focus.
import { execFileSync } from "node:child_process";

export function focusFigma() {
  const ps = [
    "$p = Get-Process Figma -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1;",
    "if (-not $p) { Write-Output 'no-figma-window'; exit 0 }",
    "$sh = New-Object -ComObject WScript.Shell;",
    "$ok = $sh.AppActivate($p.Id);",
    "Write-Output ($(if ($ok) { 'focused' } else { 'refused' }))",
  ].join(" ");
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 15000 }).trim();
    return out;
  } catch (e) { return "failed: " + String(e.message).slice(0, 80); }
}

if (import.meta.url === "file:///" + process.argv[1].split("\\").join("/")) {
  console.log(focusFigma());
}
