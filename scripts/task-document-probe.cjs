// Run local PDF parsing in the actual Electron/ASAR runtime during package checks.
process.on("message", async message => {
  try {
    const { readTaskDocument } = require(message.modulePath);
    process.send({ id: message.id, result: await readTaskDocument(message.task, message.input) });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
