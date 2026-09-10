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
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function focusWindows() {
  const ps = [
    "$p = Get-Process Figma -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1;",
    "if (-not $p) { Write-Output 'no-figma-window'; exit 0 }",
    "$sh = New-Object -ComObject WScript.Shell;",
    "$ok = $sh.AppActivate($p.Id);",
    "Write-Output ($(if ($ok) { 'focused' } else { 'refused' }))",
  ].join(" ");
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", timeout: 15000 }).trim();
}

function focusMac() {
  // Ask whether Figma is running before asking it to come forward. "tell application to activate"
  // would launch it, and a render step that silently starts the app it was meant to photograph is
  // worse than one that says the window is not there.
  try { execFileSync("pgrep", ["-x", "Figma"], { encoding: "utf8", timeout: 10000 }); }
  catch (e) { return "no-figma-window"; }
  // Plain "activate" needs no accessibility permission, unlike anything routed through System
  // Events — worth keeping, because that permission is a dialog the designer has to find and grant.
  execFileSync("osascript", ["-e", 'tell application "Figma" to activate'], { encoding: "utf8", timeout: 15000 });
  return "focused";
}

export function focusFigma() {
  try {
    if (process.platform === "win32") return focusWindows();
    if (process.platform === "darwin") return focusMac();
    // Nothing portable raises a window on Linux, and guessing at wmctrl would report success it
    // cannot deliver. Say what is true: the renders will hang unless the window is in front.
    return "unsupported-platform (" + process.platform + ") — put the Figma window in front yourself";
  } catch (e) { return "failed: " + String(e.message).slice(0, 80); }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log(focusFigma());
}
