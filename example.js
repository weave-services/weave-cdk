import { run, resume, use } from './src/index.js';

// Register a spec (from sequential-wrapper)
use({
  name: 'api',
  methods: ['users.create', 'users.get', 'greet']
}, 'https://api.example.com');

// Code uses natural syntax - automatically transformed to fetch calls
const code = `
  const user = await api.users.create({ name: "Bob" })
  const greeting = await api.greet("World")
  return { user, greeting }
`;

let task = await run(code, 'task-1');
console.log(task);

// Simulate resume with responses
task = await resume('task-1', { id: 1, name: 'Bob' });
console.log(task);

task = await resume('task-1', 'Hello, World!');
console.log(task);
