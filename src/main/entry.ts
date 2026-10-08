// Select the process role before loading desktop windows, task workers, or the
// desktop single-instance lock. Both roles keep the same OS credential identity.
if (process.argv.includes('--profilepilot-browser-service')) {
  require('./browser-service/main');
} else {
  require('./main');
}
