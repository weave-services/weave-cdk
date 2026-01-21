import { flow } from './src/index.js';

// Now you can write natural multiline code with return statements
const code = `
  const user = await fetch("https://api.example.com/user/1")
  const posts = await fetch("https://api.example.com/posts?uid=" + user.id)
  return { user, posts }
`;

(async () => {
  // Simple API: flow.run(code, { id })
  console.log('=== Run ===');
  let task = await flow.run(code, { id: 'task-1' });
  console.log('Status:', task.status);
  console.log('Fetch URL:', task.fetchRequest?.url);
  console.log();

  // Simple API: flow.resume(id, response)
  console.log('=== Resume 1 ===');
  task = await flow.resume('task-1', { id: 1, name: 'Alice' });
  console.log('Status:', task.status);
  console.log('Fetch URL:', task.fetchRequest?.url);
  console.log();

  console.log('=== Resume 2 ===');
  task = await flow.resume('task-1', [{ id: 101, title: 'Post 1' }, { id: 102, title: 'Post 2' }]);
  console.log('Status:', task.status);
  console.log('Result:', JSON.stringify(task.result, null, 2));
})();
