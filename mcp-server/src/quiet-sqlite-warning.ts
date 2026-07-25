// Node prints
//
//   (node:24808) ExperimentalWarning: SQLite is an experimental feature and
//   might change at any time
//
// on stderr the first time `node:sqlite` is touched — which is every single
// invocation of this tool. It is Node telling *us* that an API we chose is
// experimental; it is not telling the user anything they can act on, and it
// is the first thing they see every time they run `dep-rec check`.
//
// Importing this module first suppresses exactly that one warning. Every
// other warning — deprecations, unhandled rejections, anything from any
// other module — still comes through untouched, which is why this is a
// targeted filter rather than NODE_NO_WARNINGS=1 or
// process.removeAllListeners("warning"). Silencing all warnings to hide one
// would be the same kind of over-broad suppression this project spends its
// time arguing against elsewhere.
//
// The dependency on `node:sqlite` remains a real, disclosed tradeoff (see
// the README): it needs Node 22+, and the API can change under us.

const originalEmit = process.emit.bind(process);

function isSqliteExperimentalWarning(name: string | symbol, payload: unknown): boolean {
  if (name !== "warning") return false;
  const warning = payload as { name?: string; message?: string } | undefined;
  return warning?.name === "ExperimentalWarning" && /\bSQLite\b/i.test(warning.message ?? "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- process.emit is variadic and overloaded
process.emit = function (this: unknown, name: any, ...args: any[]): boolean {
  if (isSqliteExperimentalWarning(name, args[0])) return false;
  return (originalEmit as (...a: any[]) => boolean)(name, ...args);
} as typeof process.emit;
