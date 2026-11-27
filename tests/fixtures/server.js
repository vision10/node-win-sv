'use strict';
// The script run as a service by the tests: an HTTP server describing its own process.
//   PORT             port to listen on
//   WINSV_GREETING   returned as is, to check that the environment reaches the script
//   WINSV_STOP_FILE  written when the script is asked to stop, to check that it is not just killed

const fs = require('fs');
const http = require('http');

console.log('starting with ' + JSON.stringify(process.argv.slice(2)));
console.error('this line goes to the error output');

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), greeting: process.env.WINSV_GREETING }));
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on ' + process.env.PORT));

// a service is stopped with Ctrl+C, which Node.js reports as SIGINT
process.on('SIGINT', () => {
  console.log('stopping');
  if (process.env.WINSV_STOP_FILE) { fs.writeFileSync(process.env.WINSV_STOP_FILE, 'stopped by SIGINT') }
  process.exit(0);
});
