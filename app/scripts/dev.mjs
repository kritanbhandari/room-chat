import './build.mjs';
import { createServer, loadAssets, defaultDatabasePath } from '../server.mjs';
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const app = createServer({ databasePath: process.env.CHAT_DATABASE || defaultDatabasePath(), assets: loadAssets(), port });
console.log(`Room Chat is running at ${await app.listen()}`);
console.log('Local accounts and messages are saved in .local/chat.sqlite. Press Ctrl+C to stop.');
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return; closing = true; await app.close(); process.exit(0);
});
