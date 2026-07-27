// Guards the version-matrix test scripts.
//
// `npm run test:node18` is only meaningful if it actually ran on Node 18.
// Without this check it would happily run on whatever `node` is first on
// PATH and report a compatibility result for a runtime nobody tested — the
// most expensive kind of green tick, because it looks like evidence.
//
// Usage: node scripts/assert-runtime.mjs <major>

const want = Number(process.argv[2]);
const got = Number(process.versions.node.split(".")[0]);

if (!Number.isInteger(want)) {
  console.error("usage: node scripts/assert-runtime.mjs <major>");
  process.exit(2);
}

if (got !== want) {
  console.error(
    `This suite must run on Node ${want}.x, but the runtime is ${process.version}.`,
  );
  console.error(
    `Select a Node ${want} runtime first (nvm/fnm/volta use, or a portable build)`,
  );
  console.error(`and re-run, or use \`npm run test:node${got}\` instead.`);
  process.exit(1);
}

console.log(`runtime ok: ${process.version}`);
