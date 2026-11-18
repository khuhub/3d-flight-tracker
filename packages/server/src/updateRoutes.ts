/**
 * Rebuilds the bundled route database from Virtual Radar Server's standing data
 * (https://github.com/vradarserver/standing-data, CC0 1.0).
 *
 *   npm run routes:update                      # downloads the current snapshot (~6 MB)
 *   npm run routes:update -- --from=<dir>      # uses an already extracted checkout
 *
 * Writes data/routes/routes.json.gz. Routes whose airports are unknown are dropped.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { WireAirport } from '@flight/shared';
import { REPO_ROOT } from './config';
import { ROUTES_FORMAT, type RouteFile } from './routes';

const TARBALL = 'https://codeload.github.com/vradarserver/standing-data/tar.gz/main';
const CALLSIGN = /^[A-Z0-9]{2,8}$/;
const ICAO = /^[A-Z0-9]{3,4}$/;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function csvFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.csv'))
    .map((e) => join(e.parentPath, e.name));
}

/** Minimal RFC 4180 line parser (quoted fields may contain commas). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(field);
      field = '';
    } else field += c;
  }
  out.push(field);
  return out;
}

/** CSV rows as column accessors returning trimmed text ('' when absent). */
function rows(file: string): ((column: string) => string)[] {
  const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = parseCsvLine(lines[0]!);
  return lines.slice(1).map((l) => {
    const cells = parseCsvLine(l);
    return (column: string) => (cells[header.indexOf(column)] ?? '').trim();
  });
}

export function buildRouteFile(root: string, generatedAt = new Date().toISOString()): RouteFile {
  const allAirports = new Map<string, WireAirport>();
  for (const file of csvFiles(join(root, 'airports', 'schema-01'))) {
    for (const r of rows(file)) {
      // Routes reference airports by the Code column (normally the ICAO code).
      const icao = (r('Code') || r('ICAO')).toUpperCase();
      if (r('Latitude') === '' || r('Longitude') === '') continue;
      const lat = Number(r('Latitude'));
      const lon = Number(r('Longitude'));
      if (!ICAO.test(icao) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      allAirports.set(icao, [r('Name') || icao, r('IATA') || null, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]);
    }
  }
  const routes: Record<string, string> = {};
  const used = new Set<string>();
  for (const file of csvFiles(join(root, 'routes', 'schema-01'))) {
    for (const r of rows(file)) {
      const callsign = r('Callsign').toUpperCase();
      const codes = r('AirportCodes').toUpperCase().split('-');
      if (!CALLSIGN.test(callsign) || codes.length < 2 || !codes.every((c) => allAirports.has(c))) continue;
      routes[callsign] = codes.join('-');
      for (const c of codes) used.add(c);
    }
  }
  const airports: Record<string, WireAirport> = {};
  for (const icao of [...used].sort()) airports[icao] = allAirports.get(icao)!;
  return {
    format: ROUTES_FORMAT,
    source: 'Virtual Radar Server standing data, https://github.com/vradarserver/standing-data',
    license: 'CC0-1.0',
    generatedAt,
    airports,
    routes,
  };
}

function main(): void {
  const out = resolve(REPO_ROOT, arg('out') ?? 'data/routes/routes.json.gz');
  let root = arg('from');
  let temp: string | null = null;
  if (!root) {
    temp = mkdtempSync(join(tmpdir(), 'standing-data-'));
    console.log(`Downloading ${TARBALL}`);
    execFileSync('curl', ['-sSfL', '--max-time', '300', '-o', join(temp, 'sd.tgz'), TARBALL], { stdio: 'inherit' });
    execFileSync('tar', ['xzf', join(temp, 'sd.tgz'), '-C', temp], { stdio: 'inherit' });
    root = join(temp, 'standing-data-main');
  }
  try {
    const file = buildRouteFile(resolve(root));
    mkdirSync(dirname(out), { recursive: true });
    const gz = gzipSync(JSON.stringify(file), { level: 9 });
    writeFileSync(out, gz);
    console.log(
      `Wrote ${Object.keys(file.routes).length.toLocaleString()} routes and ${Object.keys(file.airports).length.toLocaleString()} airports ` +
        `(${(gz.length / 2 ** 20).toFixed(1)} MiB) to ${out}`,
    );
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith('updateRoutes.ts')) main();
