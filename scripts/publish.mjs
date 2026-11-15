// Publishes every package whose version isn't on npm yet, in the order they depend on each other:
//
//   node scripts/publish.mjs [--dry-run]
//
// Each package has its own version, so a release is "bump the ones that changed" (see
// docs/releasing.md). A version already on npm is skipped, so this can be run again after a
// failure. In GitHub Actions (.github/workflows/release.yml, on every push to main) it publishes
// with provenance, authenticating as an npm trusted publisher: no token is stored. By hand it
// needs `npm login`, and must be run on main with a clean tree. --dry-run does everything but
// publish. Last, it prints a `released <short-name> <version>` line for every package whose
// version is on npm, which the workflow uses to tag and make the GitHub releases.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry-run");
const actions = process.env.GITHUB_ACTIONS === "true";
// A shell, because npm is a .cmd file on Windows, which Node won't start directly. The arguments are fixed strings.
const npm = (args, cwd, stdio = "inherit") => spawnSync("npm", args, { cwd, stdio, shell: true, encoding: "utf8" });

const packages = readdirSync(join(repo, "packages"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ dir: join("packages", d.name), short: d.name, ...JSON.parse(readFileSync(join(repo, "packages", d.name, "package.json"), "utf8")) }))
  .filter((p) => !p.private);

// What a package needs from this repository goes first.
const names = new Set(packages.map((p) => p.name));
const ordered = [];
const visit = (p, trail = []) => {
  if (ordered.includes(p)) return;
  if (trail.includes(p)) throw new Error(`publish: a dependency cycle: ${[...trail, p].map((x) => x.name).join(" → ")}`);
  for (const dep of Object.keys({ ...p.dependencies, ...p.peerDependencies })) if (names.has(dep)) visit(packages.find((x) => x.name === dep), [...trail, p]);
  ordered.push(p);
};
packages.forEach((p) => visit(p));

const branch = actions ? process.env.GITHUB_REF_NAME : execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
if (!dry && branch !== "main") throw new Error(`publish: run this on main (you're on ${branch}); merge the release PR and pull first`);
if (!dry && dirty) throw new Error(`publish: the working tree has uncommitted changes:\n${dirty}`);

const onNpm = (p) => npm(["view", `${p.name}@${p.version}`, "version"], repo, "pipe").stdout.trim() === p.version;

console.log(`publish:${dry ? " (dry run)" : ""} ${ordered.map((p) => `${p.name}@${p.version}`).join(", ")}`);
if (npm(["run", "build"], repo).status !== 0) throw new Error("publish: the build failed");
for (const p of ordered) {
  if (onNpm(p)) {
    console.log(`publish: ${p.name}@${p.version} is already on npm, skipping`);
    continue;
  }
  console.log(`publish: ${p.name}@${p.version}`);
  // A prerelease (1.0.0-rc.1) goes out under `next`, so it is never what `npm install` gives.
  const flags = ["--access", "public", ...(p.version.includes("-") ? ["--tag", "next"] : []), ...(actions ? ["--provenance"] : []), ...(dry ? ["--dry-run"] : [])];
  if (npm(["publish", ...flags], join(repo, p.dir)).status !== 0) {
    throw new Error(`publish: ${p.name} failed; fix it and run this again (packages already on npm are skipped)`);
  }
}
const released = dry ? [] : ordered.filter(onNpm);
for (const p of released) console.log(`released ${p.short} ${p.version}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `released<<EOF\n${released.map((p) => `${p.short} ${p.version}`).join("\n")}\nEOF\n`);
console.log("publish: done.");
