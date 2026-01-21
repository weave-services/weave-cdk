# sequential

Pause/resume code at fetch() calls.

```javascript
import { run, resume } from 'sequential';

const code = `
  const user = await fetch("https://api.example.com/user/1")
  const posts = await fetch("https://api.example.com/posts?uid=" + user.id)
  return { user, posts }
`;

let task = await run(code, 'task-1');
// { id: 'task-1', status: 'paused', fetch: { url: '...' } }

task = await resume('task-1', { id: 1, name: 'Alice' });
// { id: 'task-1', status: 'paused', fetch: { url: '...' } }

task = await resume('task-1', [{ id: 101 }]);
// { id: 'task-1', status: 'done', result: { user: {...}, posts: [...] } }
```

## With sequential-wrapper

```javascript
import { run, resume, use } from 'sequential';

// Register a spec from sequential-wrapper
use({
  name: 'api',
  methods: ['users.create', 'users.get']
}, 'https://api.example.com');

// Natural syntax - auto-transformed to fetch calls
const code = `
  const user = await api.users.create({ name: "Bob" })
  return { user }
`;

let task = await run(code, 'task-1');
task = await resume('task-1', { id: 1, name: 'Bob' });
// { status: 'done', result: { user: { id: 1, name: 'Bob' } } }
```

## Storage

```javascript
run.storage = {
  async get(id) {},
  async set(id, value) {},
  async del(id) {}
};
```
