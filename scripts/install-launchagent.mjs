import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../src/protocol.mjs';

assert(process.platform === 'darwin' && typeof process.getuid === 'function', 'macOS login session required');
const archive = process.env.MARKET_ARCHIVE_DIR;
const cli = process.env.MARKET_YATAVERSE_CLI;
assert(archive?.startsWith('/') && cli?.startsWith('/'), 'Set absolute MARKET_ARCHIVE_DIR and MARKET_YATAVERSE_CLI');
const label = 'network.awai.itonami.market-feed';
const domain = 'gui/' + process.getuid();
const root = fileURLToPath(new URL('../', import.meta.url));
const agentDirectory = join(homedir(), 'Library', 'LaunchAgents');
const target = join(agentDirectory, label + '.plist');
const env = { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', MARKET_ARCHIVE_DIR: archive, MARKET_YATAVERSE_CLI: cli };
if (process.env.MARKET_ETHEREUM_RPC) {
  const endpoint = new URL(process.env.MARKET_ETHEREUM_RPC);
  assert(!endpoint.username && !endpoint.password && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash,
    'The LaunchAgent installer accepts an RPC origin without credentials in its URL.');
  env.MARKET_ETHEREUM_RPC = endpoint.origin;
}

const escape = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const string = (s) => '<string>' + escape(s) + '</string>';
const record = (entries) => Object.entries(entries).map(([key, value]) => '<key>' + key + '</key>' + value).join('');
const dict = (entries) => '<dict>' + record(entries) + '</dict>';
const calendar = [0, 6, 12, 18].map((hour) => dict({ Hour: '<integer>' + hour + '</integer>', Minute: '<integer>10</integer>' })).join('');
const plist = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  + '<plist version="1.0">' + dict({
    Label: string(label),
    ProgramArguments: '<array>' + string(process.execPath) + string(join(root, 'scripts', 'publish.mjs')) + '</array>',
    WorkingDirectory: string(root),
    EnvironmentVariables: dict(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, string(value)]))),
    RunAtLoad: '<true/>',
    StartCalendarInterval: '<array>' + calendar + '</array>',
    StandardOutPath: string(join(archive, 'publisher.log')),
    StandardErrorPath: string(join(archive, 'publisher-error.log')),
  }) + '</plist>\n';
await mkdir(archive, { recursive: true, mode: 0o700 });
await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
try {
  await writeFile(target, plist, { mode: 0o600, flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  assert(await readFile(target, 'utf8') === plist, 'Existing LaunchAgent differs. Review it before replacement.');
}
execFileSync('/usr/bin/plutil', ['-lint', target], { stdio: 'inherit' });
if (spawnSync('/bin/launchctl', ['print', domain + '/' + label], { stdio: 'ignore' }).status !== 0) {
  execFileSync('/bin/launchctl', ['bootstrap', domain, target], { stdio: 'inherit' });
}
console.log('LaunchAgent loaded: ' + label);
