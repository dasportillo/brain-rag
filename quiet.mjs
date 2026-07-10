// Silence the noisy `ExperimentalWarning: SQLite is an experimental feature` that node:sqlite emits
// on every run. Imported FIRST by the entry points so the patch is in place before node:sqlite loads.
const emit = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && /SQLite is an experimental feature/i.test(msg)) return;
  return emit(warning, ...rest);
};
