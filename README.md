# Room Chat

A local browser chat application with private rooms, local accounts, and persistent message history. Built with standard browser APIs, Node.js, and SQLite, with no third-party runtime dependencies.

## Quick start

Requires **Node.js 24 or newer**.

```sh
git clone https://github.com/kritanbhandari/room-chat.git
cd room-chat
npm start
```

Open **http://localhost:3000**. No `npm install` step is needed. The server binds to `127.0.0.1`, so the application is available on your computer only. Keep the terminal running; press Ctrl+C to stop.

On macOS, you can also double-click `Start Room Chat.command`.

## Features

- Local username/password accounts with salted scrypt password hashes.
- HttpOnly, SameSite session cookies with seven-day sessions.
- Private rooms with invitation codes that the owner can rotate.
- Server-side membership checks for room history and message access.
- SQLite storage for accounts, rooms, and message history.
- Online member lists using periodic heartbeats.
- Message updates approximately every 1.5 seconds while the page is visible.
- Earlier-message pagination and duplicate-send protection.
- Input validation and per-user request limits, including 30 messages per minute.

## Try it

1. Register an account and create a room.
2. Copy the invitation code.
3. Open an incognito window or a different browser profile, register another account, and join with the code.
4. Exchange messages, then restart the server to check the saved history.

Ordinary tabs share a login. Use separate browser profiles for different accounts. Room members can read existing history. Leaving a room removes access until a valid invitation is used again.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Build browser assets and start the local server |
| `npm run build` | Package the browser assets |
| `npm test` | Run five integration tests against real SQLite without opening a port |
| `npm run test:http` | Run the same suite through real localhost HTTP connections |

The integration suite covers authentication, room access, invitation rotation, message validation, rate limits, retry deduplication, pagination, password hashing, persistence, browser assets, and health responses.

## Configuration and storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Local server port |
| `CHAT_DATABASE` | `.local/chat.sqlite` | SQLite database path |

For example:

```sh
PORT=3001 npm start
```

Database tables are created automatically using versioned SQL migrations. The `.local/` directory contains private account and conversation data and is excluded from Git. Stop the server before backing up this directory. Generated browser assets under `dist/` are also excluded.

## Structure

```text
app/
  public/       Browser HTML, CSS, and JavaScript
  scripts/      Build and local start scripts
  test/         Integration tests
  api.mjs       Rooms, messages, presence, and rate limits
  auth.mjs      Accounts, password hashing, and sessions
  database.mjs  SQLite adapter and migrations
  server.mjs    Local HTTP server

drizzle/        SQL migrations
docs/           Project presentation as PDF
```

## Presentation

[View the 10-slide project presentation](docs/room-chat-presentation.pdf).

## Current scope

The app is designed for local use. Password recovery, message search, and file uploads are potential future additions.
