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

## Storage

```javascript
run.storage = {
  async get(id) {},
  async set(id, value) {},
  async del(id) {}
};
```
