import express from 'express';
import http from 'http';
import path from 'path';

import { WebSocketServer } from 'ws';
import { db, initDB } from './db.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());

app.get('/', (_, res) => {
  res.sendFile(path.resolve('./index.html'))
})

// Simple health check
app.get('/health', (_, res) => {
  res.json({ ok: true });
});

// Fetch recent chat history
app.get('/messages', async (_, res) => {
  const messages = await db.all`
    SELECT id, username, content, created_at
    FROM messages
    ORDER BY id DESC
    LIMIT 50
  `;
  res.json(messages.reverse());
});

// WebSocket handling
wss.on('connection', (socket) => {
  socket.on('message', async (raw) => {
    let payload;

    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { username, content } = payload;
    if (!username || !content) return;

    const createdAt = Date.now();

    // Non-blocking DB write (runs in worker thread)
    await db.run`
      INSERT INTO messages (username, content, created_at)
      VALUES (${username}, ${content}, ${createdAt})
    `;

    const outgoing = JSON.stringify({
      username,
      content,
      created_at: createdAt
    });

    // Broadcast to all connected clients
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(outgoing);
      }
    }
  });
});

await initDB();

server.listen(3000, () => {
  console.log('Chat server listening on http://localhost:3000');
});
