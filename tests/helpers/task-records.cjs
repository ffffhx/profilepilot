const fs = require('node:fs');
const path = require('node:path');

// Inspect committed disk contents without TaskStore's startup recovery mutations.
exports.readTaskRecords = file => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.version === 3) data.tasks = data.tasks.map(reference =>
    JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'task-records', reference.record), 'utf8')));
  return data;
};
