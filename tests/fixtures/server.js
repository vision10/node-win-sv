'use strict';
// Answers every request with details about the process, used by test/integration.js

const http = require('http');

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), greeting: process.env.WINSV_GREETING }));
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening on ' + process.env.PORT));
