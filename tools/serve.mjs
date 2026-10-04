// Just the job server, idling. For checking that the Figma plugin can reach the runner before
// committing to a full migration, and for driving jobs by hand.
//   node serve.mjs
//
// Always on 3778. The plugin can reach nothing else (figma-plugin/manifest.json, src/ui.html), and
// every start writes figma-plugin/dist with a new key: a server on another port would replace the key
// of a runner live on 3778 with one no plugin window can ever use.
import { openSession } from "./session.mjs";
const port = Number(process.argv[2] || 3778);
if (port !== 3778) {
  console.error("the Figma plugin can only reach localhost:3778; another port would only overwrite figma-plugin/dist with a key no plugin can use");
  process.exit(2);
}
const srv = await openSession({ port });
console.log("job server idling on http://localhost:" + port);
console.log("the plugin should switch from 'connecting…' to 'idle — waiting for the next job'");
console.log("ctrl-c to stop");
