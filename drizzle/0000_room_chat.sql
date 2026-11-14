CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 40)
);
--> statement-breakpoint
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
  invite_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(room_id, user_id)
);
--> statement-breakpoint
CREATE INDEX room_members_user ON room_members(user_id, room_id);
--> statement-breakpoint
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
  created_at INTEGER NOT NULL,
  UNIQUE(room_id, user_id, client_id)
);
--> statement-breakpoint
CREATE INDEX messages_room_id ON messages(room_id, id);
--> statement-breakpoint
CREATE TABLE presence (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY(room_id, user_id, session_id),
  FOREIGN KEY(room_id, user_id) REFERENCES room_members(room_id, user_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX presence_recent ON presence(room_id, last_seen);
--> statement-breakpoint
CREATE TABLE rate_limits (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  window INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(user_id, action, window)
);
