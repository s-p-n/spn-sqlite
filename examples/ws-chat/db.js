import DB from 'spn-sqlite';

export const db = new DB({
  filename: './chat.db'
});

// Initialize schema
export async function initDB() {
  await db.exec`PRAGMA journal_mode = WAL`;

  await db.exec`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `;
}
