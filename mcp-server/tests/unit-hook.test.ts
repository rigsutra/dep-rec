// Which packages the install hook sees in a shell command. Offline: this is
// only the tokenizer, and its failure mode matters in both directions — a
// missed install goes unchecked, a misread token could block a developer.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findPackageRequests, splitSpec } from "../src/hook/command.js";

const names = (cmd: string) => findPackageRequests(cmd).map((r) => (r.spec ? `${r.name}@${r.spec}` : r.name));

describe("hook — finding package requests", () => {
  const cases: Array<[string, string[]]> = [
    ["npm install lodash", ["lodash"]],
    ["npm i -D typescript@^5 @types/node@18", ["typescript@^5", "@types/node@18"]],
    ["npm isntall chalk", ["chalk"]],
    ["pnpm add zod", ["zod"]],
    ["yarn add react react-dom", ["react", "react-dom"]],
    ["yarn global add serve", ["serve"]],
    ["bun add hono", ["hono"]],
    ["cd web && npm i axios; npm test", ["axios"]],
    ["NODE_ENV=dev npm install --save-exact ms@2.1.3", ["ms@2.1.3"]],
    ["sudo npm install -g pm2", ["pm2"]],
    ["npm install --registry https://r.example.com left-pad", ["left-pad"]],
    ['npm install "lodash@>=4 <5"', ["lodash@>=4 <5"]],
    ["npm i my-alias@npm:real-pkg@1.2.3", ["real-pkg@1.2.3"]],
    ["npx -y create-vite@5 my-app --template react", ["create-vite@5"]],
    ["npx -p typescript tsc --init", ["typescript"]],
    ["npx --package=@angular/cli ng new app", ["@angular/cli"]],
    ["pnpm dlx degit user/repo", ["degit"]],
    ["npm.cmd install express", ["express"]],
  ];
  for (const [cmd, expected] of cases) {
    test(cmd, () => assert.deepEqual(names(cmd), expected));
  }

  const ignored = [
    "npm install",
    "npm ci",
    "npm test",
    "npm run build -- --watch",
    "npm install ./packages/local",
    "npm install ../sibling",
    "npm install file:../x",
    "npm install github:user/repo",
    "npm install user/repo",
    "npm install https://example.com/pkg.tgz",
    "npm install ./pkg-1.0.0.tgz",
    "pnpm install",
    "yarn",
    "echo npm install lodash",
    "git commit -m 'npm install lodash'",
  ];
  for (const cmd of ignored) {
    test(`ignores: ${cmd}`, () => assert.deepEqual(names(cmd), []));
  }

  test("install vs exec is recorded", () => {
    assert.equal(findPackageRequests("npm i a")[0].kind, "install");
    assert.equal(findPackageRequests("npx a")[0].kind, "exec");
  });

  test("splitSpec handles scopes and bare names", () => {
    assert.deepEqual(splitSpec("@scope/pkg@^1.2.0"), { name: "@scope/pkg", spec: "^1.2.0" });
    assert.deepEqual(splitSpec("@scope/pkg"), { name: "@scope/pkg", spec: null });
    assert.deepEqual(splitSpec("pkg@"), { name: "pkg", spec: null });
  });
});
