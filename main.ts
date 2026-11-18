// Token Radar, entrypoint (Node 22, standard library only).
// Run it against the sealed snapshot and it produces the whole hand-in:
// the ranked board, the dashboard's dataset, the dashboard and screenshots,
// and the dossier the judge rebuilds from /output. The scoring itself lives
// in lib/model.ts; this file only wires the command line, the snapshot and
// the output directory together, then checks the result against the gate
// before anything is written. Radar-3 fits its size curve to the snapshot's
// own traded tokens at run time and tests it leave-one-out before it ranks
// anything, so the numbers the dashboard prints are measured, not asserted.
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
// --input takes a snapshot file or the directory that holds snapshot.json
// (default /input, the sealed mount inside the grader's container).
// --output takes the directory to write to; MAKEFUN_OUTPUT_DIR is the other
// way to set it (default /output).

import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSnapshot, buildRadar } from './lib/model.ts';
import { boardIssue, dataScript } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** The directory this file lives in, so dashboard/ and screenshots/ are found. */
function repoRoot(): string {
  return fileURLToPath(new URL('.', import.meta.url));
}

/** One flag's value: `--name value` or `--name=value`, else `fallback`. */
function flagValue(argv: string[], name: string, fallback: string): string {
  const marker = `--${name}`;
  const at = argv.indexOf(marker);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1] as string;
  const joined = argv.find((a) => a.startsWith(`${marker}=`));
  return joined === undefined ? fallback : joined.slice(marker.length + 1);
}

/** Write a message to stderr and stop with the given status. */
function fail(message: string, status: number): never {
  process.stderr.write(message);
  process.exit(status);
}

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const SHOT_NAME = new RegExp('^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$');

const argv = process.argv;
const inputGiven = flagValue(argv, 'input', '/input');
const snapshotPath = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(`token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`, 2);
}
const outDir = flagValue(argv, 'output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const refused = boardIssue(board, snapshot);
if (refused !== null) {
  fail(`token radar: the model wrote a board the gate refuses: ${refused}\n`, 1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyPlainFiles(fromDir: string, toDir: string): string[] {
  if (!existsSync(fromDir)) return [];
  mkdirSync(toDir, { recursive: true });
  const moved: string[] = [];
  for (const name of readdirSync(fromDir)) {
    if (name.startsWith('.')) continue;
    const source = join(fromDir, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(toDir, name));
    moved.push(name);
  }
  return moved;
}

const root = repoRoot();
copyPlainFiles(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyPlainFiles(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  fail(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`, 1);
}
for (const shot of shots) {
  if (!SHOT_NAME.test(shot)) {
    fail(`token radar: screenshots/${shot}: a name is letters, digits and . _ -, 1 to 128 characters\n`, 1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_CAP, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const firstLine =
  'token radar: ' +
  snapshot.protocols.length +
  ' protocols, ' +
  snapshot.watchlist.length +
  ' on the watchlist, ' +
  board.length +
  ' rows scored (' +
  radar.early_size +
  ' early, ' +
  radar.live_size +
  ' live set aside), fit on ' +
  radar.fit.n +
  ' traded comps: log10(mcap) = ' +
  radar.fit.intercept +
  ' + ' +
  radar.fit.slope +
  ' x log10(tvl), R2 ' +
  radar.fit.r2 +
  ', leave-one-out median error ' +
  radar.validation.chosen.median +
  ' log points vs flat ' +
  radar.validation.flat_multiple.median;
const secondLine =
  'token radar: wrote ' +
  join(outDir, 'board.json') +
  ', ' +
  join(outDir, 'data.js') +
  ', ' +
  join(outDir, 'dashboard') +
  ' (3 files), ' +
  join(outDir, 'screenshots') +
  ' (' +
  shots.length +
  ' images) and ' +
  join(outDir, 'dossier.json');
process.stdout.write(firstLine + '\n' + secondLine + '\n');
