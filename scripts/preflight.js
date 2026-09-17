import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  REQUIRED_DEPLOY_ENV,
  VERSION,
  requiredRuntimeEnv,
  runtimeConfigStatus
} from '../api/lib/config.js';
import { ROOT, listFiles, loadDotEnv, printResult, requireEnv } from './script-utils.js';

loadDotEnv();

const REQUIRED_FILES = [
  'package.json',
  'vercel.json',
  '.env.example',
  'README.md',
  'Dockerfile',
  'docker-compose.yml',
  'Makefile',
  'eslint.config.js',
  'prettier.config.js',
  'jest.config.js',
  'api/lib/db.js',
  'api/lib/hasher.js',
  'api/lib/ownership.js',
  'api/lib/idempotency.js',
  'api/lib/provider.js',
  'api/gemini/execute.js',
  '.github/workflows/ci.yml',
  '.github/workflows/production.yml'
];

const SECRET_PATTERNS = [
  { name: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'vercel_token', pattern: /\bvercel_[A-Za-z0-9]{20,}\b/ },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ }
];

function checkNode() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  return {
    status: major >= 22 && major < 25 ? 'pass' : 'fail',
    version: process.version,
    required: '>=22 <25'
  };
}

function checkFiles() {
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(ROOT, file)));
  return {
    status: missing.length === 0 ? 'pass' : 'fail',
    missing
  };
}

function checkPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return {
    status: pkg.version === VERSION ? 'pass' : 'fail',
    packageVersion: pkg.version,
    expected: VERSION
  };
}

function checkHardcodedSecrets() {
  const matches = [];
  for (const file of listFiles(ROOT)) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    if (/\.(png|jpg|jpeg|gif|pdf|zip|gz|lock)$/i.test(rel)) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        matches.push({ file: rel, pattern: name });
      }
    }
  }
  return {
    status: matches.length === 0 ? 'pass' : 'fail',
    matches
  };
}

function main() {
  const production = process.argv.includes('--production');
  const checks = {
    node: checkNode(),
    files: checkFiles(),
    packageVersion: checkPackageVersion(),
    hardcodedSecrets: checkHardcodedSecrets(),
    config: runtimeConfigStatus()
  };

  if (production) {
    requireEnv([...requiredRuntimeEnv(), ...REQUIRED_DEPLOY_ENV]);
  }

  const failed = Object.values(checks).some((check) => check.status === 'fail');
  printResult({
    status: failed ? 'fail' : 'pass',
    production,
    checks
  });

  if (failed) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  printResult({
    status: 'fail',
    error: {
      message: error.message,
      missing: error.missing ?? []
    }
  });
  process.exitCode = 1;
}
