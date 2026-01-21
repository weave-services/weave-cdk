import { run, resume } from './src/index.js';

const code = `
  const user = await fetch("https://api.example.com/user/1")
  const posts = await fetch("https://api.example.com/posts?uid=" + user.id)
  return { user, posts }
`;

let task = await run(code, 'task-1');
console.log(task);

task = await resume('task-1', { id: 1, name: 'Alice' });
console.log(task);

task = await resume('task-1', [{ id: 101, title: 'Post 1' }]);
console.log(task);
