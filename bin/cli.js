#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { run } = require('../src/index');

// ─── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

function getArg(flag) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
    if (args[i].startsWith(flag + '=')) return args[i].split('=').slice(1).join('=');
  }
  return null;
}

function printHelp() {
  const C = {
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  };
  console.log(`
${C.cyan('╔══════════════════════════════════════════════════════════════╗')}
${C.cyan('║')} ${C.bold('oracle-schema-diff')} ${C.dim('v' + require('../package.json').version)}${' '.repeat(40 - require('../package.json').version.length)}${C.cyan('║')}
${C.cyan('║')} ${C.dim('Compare two Oracle schemas, generate migration SQL & reports')}  ${C.cyan('║')}
${C.cyan('╚══════════════════════════════════════════════════════════════╝')}

${C.bold('USAGE')}
  oracle-schema-diff                               ${C.dim('# interactive mode')}
  oracle-schema-diff --config path/to/config.json  ${C.dim('# load from JSON file')}
  oracle-schema-diff [flags]                       ${C.dim('# non-interactive')}

${C.bold('CONNECTION FLAGS')}
  ${C.cyan('--sit-user')}      <user>       Source (SIT) schema/username
  ${C.cyan('--sit-password')}  <password>   Source password
  ${C.cyan('--sit-url')}       <url>        Source connect string  ${C.dim('(host:port/service or JDBC URL)')}
  ${C.cyan('--prod-user')}     <user>       Target (PROD) schema/username
  ${C.cyan('--prod-password')} <password>   Target password
  ${C.cyan('--prod-url')}      <url>        Target connect string

${C.bold('OUTPUT FLAGS')}
  ${C.cyan('--lib-dir')}       <path>       Oracle Instant Client lib dir
  ${C.cyan('--output')}        <file>       Write SQL to specific file ${C.dim('(default: auto-named)')}
  ${C.cyan('--html-report')}   [file]       Generate 5-tab HTML report
  ${C.cyan('--open-report')}                Auto-open the HTML report in browser
  ${C.cyan('--no-color')}                   Disable ANSI colors
  ${C.cyan('--config')}        <file>       Load credentials from JSON config file
  ${C.cyan('-h, --help')}                   Show this help
  ${C.cyan('-v, --version')}                Show version

${C.bold('CONFIG FILE FORMAT')} ${C.dim('(JSON)')}
  {
    "sit":  { "user": "...", "password": "...", "url": "host:port/service" },
    "prod": { "user": "...", "password": "...", "url": "host:port/service" },
    "libDir": "/path/to/oracle/lib",
    "htmlReportPath": "./schema-report.html"
  }

${C.bold('EXAMPLES')}
  ${C.dim('# Interactive (prompts for all credentials)')}
  oracle-schema-diff

  ${C.dim('# Non-interactive with flags')}
  oracle-schema-diff \\
    --sit-user SIT_SCHEMA --sit-password secret --sit-url 10.0.0.1:1521/SIT \\
    --prod-user PROD_SCHEMA --prod-password secret --prod-url 10.0.0.2:1521/PROD \\
    --html-report --open-report

  ${C.dim('# Config file + visual report')}
  oracle-schema-diff --config ./sit-to-prod.json --html-report --open-report

${C.green('Tip:')} Accepts JDBC URLs: jdbc:oracle:thin:@//host:port/service
`);
}

// ─── Credential resolution ─────────────────────────────────────────────────────

async function resolveConfig() {
  // 1. Config file
  const configFile = getArg('--config');
  if (configFile) {
    const resolvedPath = path.resolve(configFile);
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const cfg = JSON.parse(raw);

    if (!cfg.sit || !cfg.sit.user || !cfg.sit.password || !cfg.sit.url) {
      throw new Error('Config file missing required "sit" fields: user, password, url');
    }
    if (!cfg.prod || !cfg.prod.user || !cfg.prod.password || !cfg.prod.url) {
      throw new Error('Config file missing required "prod" fields: user, password, url');
    }

    return {
      sit: cfg.sit,
      prod: cfg.prod,
      libDir: cfg.libDir || null,
      output: getArg('--output') || null,
      htmlReport: args.includes('--html-report') || Boolean(getArg('--html-report')),
      htmlReportPath: getArg('--html-report') || cfg.htmlReportPath || null,
      openReport: args.includes('--open-report'),
      colors: !args.includes('--no-color'),
    };
  }

  // 2. CLI flags (all 6 required flags present = non-interactive)
  const sitUser = getArg('--sit-user');
  const sitPassword = getArg('--sit-password');
  const sitUrl = getArg('--sit-url');
  const prodUser = getArg('--prod-user');
  const prodPassword = getArg('--prod-password');
  const prodUrl = getArg('--prod-url');

  if (sitUser && sitPassword && sitUrl && prodUser && prodPassword && prodUrl) {
    return {
      sit: { user: sitUser, password: sitPassword, url: sitUrl },
      prod: { user: prodUser, password: prodPassword, url: prodUrl },
      libDir: getArg('--lib-dir') || null,
      output: getArg('--output') || null,
      htmlReport: args.includes('--html-report') || Boolean(getArg('--html-report')),
      htmlReportPath: getArg('--html-report') || null,
      openReport: args.includes('--open-report'),
      colors: !args.includes('--no-color'),
    };
  }

  // 3. Interactive mode
  return promptForCredentials();
}

async function promptForCredentials() {
  // ask() uses a fresh readline interface each call so raw-mode interference
  // between questions is impossible.
  const ask = (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });

  const askSecret = ask;

  // Color helpers (keep local so interactive mode works even if --no-color flag not yet parsed)
  const c = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
  const cyan = (s) => c('36', s);
  const bold = (s) => c('1', s);
  const dim = (s) => c('2', s);
  const green = (s) => c('32', s);
  const label = (s) => `  ${cyan('◆')} ${bold(s.padEnd(14))}`;

  const W = 60;
  console.log('');
  console.log(cyan(`╔${'═'.repeat(W)}╗`));
  console.log(cyan('║') + bold('  oracle-schema-diff  —  Interactive Setup'.padEnd(W)) + cyan('║'));
  console.log(cyan(`╚${'═'.repeat(W)}╝`));

  console.log('');
  console.log(cyan(`  ┌─  Source Database  ${'─'.repeat(W - 20)}┐`));
  console.log(cyan('  │') + dim('  The schema that has the CORRECT / up-to-date object definitions.') + '');
  console.log(cyan('  │'));
  const sitUser = await ask(label('User / Schema') + ' ');
  const sitPassword = await askSecret(label('Password') + ' ');
  const sitUrl = await ask(label('Connect URL') + dim(' (host:port/service or JDBC URL)') + ' ');
  console.log(cyan(`  └${'─'.repeat(W - 1)}`));

  if (!sitUser || !sitPassword || !sitUrl) {
    throw new Error('All Source credential fields are required.');
  }

  console.log('');
  console.log(cyan(`  ┌─  Target Database  ${'─'.repeat(W - 20)}┐`));
  console.log(cyan('  │') + dim('  The schema to be UPDATED to match the source.') + '');
  console.log(cyan('  │'));
  const prodUser = await ask(label('User / Schema') + ' ');
  const prodPassword = await askSecret(label('Password') + ' ');
  const prodUrl = await ask(label('Connect URL') + dim(' (host:port/service or JDBC URL)') + ' ');
  console.log(cyan(`  └${'─'.repeat(W - 1)}`));

  if (!prodUser || !prodPassword || !prodUrl) {
    throw new Error('All Target credential fields are required.');
  }

  console.log('');
  console.log(cyan(`  ┌─  Optional  ${'─'.repeat(W - 13)}┐`));
  console.log(cyan('  │'));
  const libDir = await ask(label('Instant Client') + dim(' (leave blank to skip)') + ' ');
  console.log(cyan(`  └${'─'.repeat(W - 1)}`));

  console.log('');
  console.log(green('  ✔  Configuration ready.') + dim('  Starting analysis…'));
  console.log('');

  return {
    sit: { user: sitUser.trim(), password: sitPassword.trim(), url: sitUrl.trim() },
    prod: { user: prodUser.trim(), password: prodPassword.trim(), url: prodUrl.trim() },
    libDir: libDir.trim() || null,
    output: null,
    htmlReport: true,
    htmlReportPath: null,
    openReport: false,
    colors: true,
  };
}

// ─── Entry ─────────────────────────────────────────────────────────────────────

resolveConfig()
  .then((config) => run(config))
  .catch((err) => {
    console.error('\n  Error:', err.message);
    process.exit(1);
  });
