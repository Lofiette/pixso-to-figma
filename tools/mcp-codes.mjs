// What mcp.mjs's exit code means, for whoever runs it and needs to tell the two failures apart.
//
// A module of its own so that mcp.mjs can stay a plain script that runs the moment it is started.
// It was briefly importable, behind an "am I the main module?" check comparing import.meta.url with
// process.argv[1]; through a symlink or a directory junction those two differ, and `node mcp.mjs`
// then did nothing at all and exited 0 — a call that silently never happened.
//
// 75 is EX_TEMPFAIL: the channel did not carry the call (connection refused or reset, no reply in
// time, 502/503/504). Every other failure exits with 1: Pixso answered, or the call was never made.
export const EXIT_TRANSPORT = 75;
