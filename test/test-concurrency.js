// test/test-concurrent.js
import DB from '../index.js';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

const DB_FILE = './forum.db'; // File-based for realism (use ':memory:' for faster tests)

let driver_arg = process.argv[2]?.replace(/^\-\-?/, '')?.replace('sqlite3','sqlite');
switch (driver_arg) {
case "node:sqlite":
  break;
case "better-sqlite":
  break;
default:
  driver_arg = "node:sqlite";
}

console.log('\nUsing driver:', driver_arg, '\n');
async function runConcurrentTest() {
  const startTime = performance.now();

  const db = new DB({
    driver: driver_arg,
    filename: DB_FILE
  });

  // Enable WAL + other pragmas for concurrency
  await db.exec`PRAGMA journal_mode = WAL`;
  await db.exec`PRAGMA synchronous = NORMAL`;
  await db.exec`PRAGMA cache_size = -64000`; // 64MB cache

  console.log('PRAGMA settings:', await db.get`PRAGMA journal_mode`);

  // Setup tables
  await db.exec`
    DROP TABLE IF EXISTS comments;
    DROP TABLE IF EXISTS posts;
    DROP TABLE IF EXISTS users;
  `;

  await db.exec`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;

  await db.exec`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `;

  await db.exec`
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES posts(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `;

  console.log('Tables created.');

  // Helper functions
  function generateId() {
    return randomUUID();
  }

  function randomUsername() {
    return `user_${Math.random().toString(36).slice(2, 8)}`;
  }

  function randomTitle() {
    const titles = ['Hello World', 'SQLite Rocks', 'Node.js Tips', 'Forum Fun'];
    return titles[Math.floor(Math.random() * titles.length)] + ` #${Math.floor(Math.random() * 100)}`;
  }

  function randomContent() {
    const contents = ['Great post!', 'I agree.', 'Interesting...', 'Thanks for sharing.'];
    return contents[Math.floor(Math.random() * contents.length)] + ` (rand: ${Math.random()})`;
  }

  // CRUD functions
  async function registerUser(username) {
    return await db.transaction(async tx => {
      const {lastInsertRowid} = await tx.run`INSERT INTO users (username) VALUES (${username})`;
      return (await tx.get`SELECT id FROM users WHERE id=${lastInsertRowid}`).id;
    });
  }

  async function createPost(userId, title, content) {
    const id = generateId();
    await db.run`INSERT INTO posts (id, user_id, title, content) VALUES (${id}, ${userId}, ${title}, ${content})`;
    return id;
  }

  async function editPost(postId, newContent) {
    await db.run`UPDATE posts SET content = ${newContent} WHERE id = ${postId}`;
  }

  async function createComment(postId, userId, content) {
    const id = generateId();
    await db.run`INSERT INTO comments (id, post_id, user_id, content) VALUES (${id}, ${postId}, ${userId}, ${content})`;
    return id;
  }

  async function editComment(commentId, newContent) {
    await db.run`UPDATE comments SET content = ${newContent} WHERE id = ${commentId}`;
  }

  async function deleteComment(commentId) {
    await db.run`DELETE FROM comments WHERE id = ${commentId}`;
  }

  async function browsePost(postId) {
    return await db.all`
      SELECT 
        p.id AS post_id, p.title, p.content, p.created_at,
        u.username AS post_author,
        c.id AS comment_id, c.content AS comment_content, c.created_at AS comment_created_at,
        cu.username AS comment_author
      FROM posts p
      LEFT JOIN users u ON p.user_id = u.id
      LEFT JOIN comments c ON c.post_id = p.id
      LEFT JOIN users cu ON c.user_id = cu.id
      WHERE p.id = ${postId}
    `;
  }

  // Snapshot function: Get current state summary
  async function getSnapshot() {
    const users = await db.get`SELECT COUNT(*) AS user_count FROM users`;
    const posts = await db.get`SELECT COUNT(*) AS post_count FROM posts`;
    const comments = await db.get`SELECT COUNT(*) AS comment_count FROM comments`;
    return {
      users: users.user_count,
      posts: posts.post_count,
      comments: comments.comment_count,
      timestamp: new Date().toISOString()
    };
  }

  // Initial snapshot
  console.log('Initial Snapshot:', await getSnapshot());

  // Seed initial data
  const userIds = [];
  for (let i = 0; i < 5; i++) {
    userIds.push(await registerUser(randomUsername()));
  }

  const postIds = [];
  for (let i = 0; i < 3; i++) {
    postIds.push(await createPost(userIds[i % userIds.length], randomTitle(), randomContent()));
  }

  //console.log('Seeded initial data.');
  console.log('Snapshot after seeding:', await getSnapshot());

  // Simulate concurrent real-world actions
  // Wave 1: Mix of creates (parallel inserts)
  console.log('\nWave 1: Concurrent creates (5 users + 10 comments)');
  await Promise.all([
    ...Array(5).fill().map(() => registerUser(randomUsername())),
    ...Array(10).fill().map(() => createComment(postIds[0], userIds[0], randomContent()))
  ]);
  console.log('Snapshot after Wave 1:', await getSnapshot());

  // Wave 2: Mix reads + writes (browse while editing/creating)
  console.log('\nWave 2: Concurrent reads + writes (browse post while editing post + adding comments)');
  const [browseResult, ...otherResults] = await Promise.all([
    browsePost(postIds[0]),
    editPost(postIds[0], 'Edited content!'),
    ...Array(5).fill().map(() => createComment(postIds[0], userIds[1], randomContent())),
    createPost(userIds[2], 'New concurrent post', 'Content')
  ]);
  //console.log('Browsed post during Wave 2:', browseResult); // May show pre-edit state due to concurrency
  console.log('Snapshot after Wave 2:', await getSnapshot());

  // Wave 3: Updates + deletes (parallel edits/deletes)
  console.log('\nWave 3: Concurrent updates + deletes (edit comments + delete some)');
  const commentIds = await db.all`SELECT id FROM comments WHERE post_id = ${postIds[0]}`;
  const toEdit = commentIds.slice(0, 5).map(c => c.id);
  const toDelete = commentIds.slice(5, 10).map(c => c.id);

  await Promise.all([
    ...toEdit.map(id => editComment(id, 'Edited comment!')),
    ...toDelete.map(id => deleteComment(id)),
    browsePost(postIds[0]) // Read during modifications
  ]);
  console.log('Snapshot after Wave 3:', await getSnapshot());

  // Wave 4: High-concurrency stress (50 mixed operations)
  console.log('\nWave 4: High-concurrency stress (50 mixed ops: creates, edits, deletes, reads)');
  const stressPromises = [];
  for (let i = 0; i < 50; i++) {
    const op = Math.random();
    if (op < 0.3) {
      stressPromises.push(createComment(postIds[Math.floor(Math.random() * postIds.length)], userIds[Math.floor(Math.random() * userIds.length)], randomContent()));
    } else if (op < 0.5) {
      const randomComment = (await db.get`SELECT id FROM comments ORDER BY RANDOM() LIMIT 1`)?.id;
      if (randomComment) stressPromises.push(editComment(randomComment, 'Stress edit'));
    } else if (op < 0.7) {
      const randomComment = (await db.get`SELECT id FROM comments ORDER BY RANDOM() LIMIT 1`)?.id;
      if (randomComment) stressPromises.push(deleteComment(randomComment));
    } else {
      stressPromises.push(browsePost(postIds[Math.floor(Math.random() * postIds.length)]));
    }
  }
  await Promise.all(stressPromises);
  console.log('Snapshot after Wave 4:', await getSnapshot());

  // Final browse example
 //console.log('\nFinal browse of first post:', await browsePost(postIds[0]));

  await db.close();

  const duration = performance.now() - startTime;
  console.log(`\nTotal test duration: ${duration.toFixed(2)}ms`);
}

runConcurrentTest().catch(console.error);