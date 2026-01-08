# spn-sqlite

**A main-thread-friendly, no-dependency SQLite library for Node.js using worker threads.**

- Fully asynchronous — never blocks **your** event loop  
- Zero native dependencies by default (uses built-in `node:sqlite`)  
- Optional high-performance and stable driver available: `better-sqlite3`  
- Excellent concurrency with WAL and smart worker management  
- Tagged template queries with safe parameter binding  
- Can Work in serverless, edge runtimes, and bundled environments  

*Note: node:sqlite is an experimental package, with some features added as late as Node.js **v25.1+** (verified on v25.2.1).*
The `better-sqlite3` driver might work on earlier versions of node but I haven't tested that.
```bash
npm install spn-sqlite
```

Optional (if you want `better-sqlite3` dependency):
```bash
npm install spn-sqlite better-sqlite3
```

## Why spn-sqlite?
Node.js programs have all sorts of bells and whistles for asynchronous operations. But when the main thread is working, there's really only one operation working at a time. If that operation blocks the main event loop, your server will lag- and that makes your users very sad. If you want your users to be happy, you can take things that seek to block the main thread, and let them play in a worker thread so that.. it just works very quickly and blocks it's own thread until it's done- which is what your users want! Your users want your server to be lightening fast and to never block. There are situations where it's better to run a blocking service that is dedicated to the task- like a microservice that is made for huge datasets that must be streamed. This package is not for that. If you try to do that with this package, you will be punished by the garbage collector- because sending huge packets of data to workers is expensive. This package is for people who want to host servers, and they use SQLite to store data, and they want their server to be able to serve requests whether SQLite is writing or not.

You want a SQL API that's fucking awesome to look at, and does caching and parameterized queries automatically for you.
```JavaScript
db.get`SELECT * FROM users WHERE username = ${'Alice'}`;

// could also be written as:
db.get(["SELECT * FROM users WHERE username = ",""], "Alice");
``` 

JavaScript's template literals make this super easy- though the other way of writing it is kind of confusing. Essentially, anywhere you would put a `?` in a parameterized query, in the template literal the string gets split there. That helpful side-effect makes it trivial to join the query back together with question marks `["SELECT * FROM users WHERE username = ",""].join('?')` which would give us `SELECT * FROM users WHERE username = ?`. And then of course the values would match up as expected- so `Alice` and that query get sent to Sqlite and then SQLite replaces the `?` with the value, blah blah boring- you've heard this before.

But- that's not all that's happening here. Everytime you write a query in your application using the `node:sqlite` driver, `spn-sqlite` automatically runs your queries in tagged statements- and that caches the parameterized queries in sqlite natively, which your users love because it makes everything load faster.

This library is for real-world usage, not numbers. It loads up workers and dispatches jobs to them automatically while keeping things First-in-First-Out, and in SQLite DBs- **writes must always synchronous**. Now, it is possible to load multiple databases- and `spn-sqlite` will happily spin up workers for each instance. So, if you have 2 DBs, then yeah you can do writes on both of them at the same time- just not multiple writes to the same SQLite db. And while all that's happening- it shouldn't ever block your main thread.


| Feature                        | spn-sqlite (default)          | spn-sqlite + better-sqlite3   | better-sqlite3 alone |
|-------------------------------|-------------------------------|-------------------------------|----------------------|
| Async / non-blocking          | Yes                           | Yes                           | No                   |
| Native dependencies           | None                          | Yes (optional)                | Yes                  |
| Serverless / edge compatible  | Yes                           | No                            | No                   |
| Real-world concurrent perf    | ~100–130 ms (forum test)      | ~100–110 ms (forum test)      | Slightly faster (sync) |
| Bulk insert speed (100k rows) | 70–80% of native              | Nearly identical to native     | Fastest              |

- Use the **default** (`node:sqlite`) driver for maximum portability and async safety- it uses only node.js standard libraries..
- Switch to the `better-sqlite3` driver when you want something more mainstream, less experimental, and very fast- but still in a worker thread to keep your servers accepting requests quickly.

## Quick Start

```js
import DB from 'spn-sqlite';

const db = new DB;

/*

Try this:

const db = new DB({
  filename: "./my_database.db",
  driver: "better-sqlite"
});

*/

await db.exec`PRAGMA journal_mode = WAL`;

await db.exec`
  DROP TABLE IF EXISTS users;
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL
  );
`;

await db.run`INSERT INTO users (id, username) VALUES (${'u1'}, ${'alice'})`;

const user = await db.get`SELECT * FROM users WHERE username = ${'alice'}`;
console.log(user);

let all_users = await db.all`SELECT * FROM users`;
console.log(all_users);
await db.close(); // Gracefully shuts down
```

## API

### Constructor

```js
new DB({
  filename = './my_database.db',   // Database file path or ':memory:'
  driver = 'node:sqlite',          // 'node:sqlite', 'better-sqlite'
  options = {},                    // Passed directly to the underlying driver- these are specific to the respective driver; see their docs.
})
```

**Driver aliases supported** (case-sensitive):
- `node:sqlite` / `node:sqlite3` → built-in driver (default)
- `better-sqlite` / `better-sqlite3` → native driver (requires `better-sqlite3` installed)


### Query Methods

All return Promises and support **tagged template literals** with parameter binding:

```js
await db.exec`CREATE TABLE ...`                     // No parameters allowed
await db.run`INSERT ... VALUES (${id}, ${name})`     // Returns { changes, lastInsertRowid }
await db.get`SELECT ... WHERE id = ${id}`           // First row or undefined
await db.all`SELECT ... FROM users`                 // Array of rows
```

### Transactions

```js
await db.transaction(async (tx) => {
  await tx.run`INSERT INTO ...`;
  const {lastInsertRowid} = await tx.run`UPDATE ...`;
  return await tx.get`SELECT ... WHERE id = ${lastInsertRowid}`;
  // Commits on success, rolls back on error
});
```

### Close

```js
await db.close();
```
Tries to terminate all workers. Any busy workers defer closing in an attempt to prevent data loss/corruption. Anything in the queue is lost, as workers are terminated immediately after they finish the job they are working on.

## Real-World Example
See [./test/test-concurrency.js](./test/test-concurrency.js)

Concurrent forum simulation (users, posts, comments):

- Initial seed + 4 waves of mixed creates, reads, edits, deletes
- 50 high-concurrency operations in final wave

**Results (file-based DB, WAL enabled):**

- `node:sqlite` (default): **~100–130 ms**
- `better-sqlite3` driver: **~100–110 ms**

Both drivers handle heavy concurrency safely with zero errors and clean shutdown.

## License

MIT