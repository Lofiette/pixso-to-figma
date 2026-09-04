// Just the job server, idling. For checking that the Figma plugin can reach the runner before
// committing to a full migration, and for driving jobs by hand.
//   node serve.mjs [port]
import { startJobServer } from "./jobserver.mjs";
const port = Number(process.argv[2] || 3778);
const srv = startJobServer(port);
await srv.ready;
console.log("job server idling on http://localhost:" + port);
console.log("the plugin should switch from 'connecting…' to 'idle — waiting for the next job'");
console.log("ctrl-c to stop");
