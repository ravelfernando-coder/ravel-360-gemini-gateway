import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, printResult } from './script-utils.js';

const MIGRATIONS_DIR = join(ROOT, 'migrations');

function checksum(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function main() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_.+\.sql$/.test(file))
    .sort();
  const versions = files.map((file) => file.slice(0, 3));
  const expected = Array.from({ length: files.length }, (_, index) => String(index + 1).padStart(3, '0'));
  const problems = [];

  if (files.length === 0 || expected.some((version, index) => versions[index] !== version)) {
    problems.push({
      code: 'MIGRATION_SEQUENCE_MISMATCH',
      expected,
      received: versions
    });
  }

  const details = files.map((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (/create\s+index\s+concurrently/i.test(sql)) {
      problems.push({ file, code: 'CONCURRENT_INDEX_NOT_TRANSACTION_SAFE' });
    }
    if (/\b(drop\s+table|truncate\s+table)\b/i.test(sql)) {
      problems.push({ file, code: 'DESTRUCTIVE_DDL_REQUIRES_MANUAL_REVIEW' });
    }
    return {
      file,
      checksum: checksum(sql),
      bytes: Buffer.byteLength(sql)
    };
  });

  printResult({
    status: problems.length === 0 ? 'pass' : 'fail',
    migrations: details,
    problems
  });

  if (problems.length > 0) {
    process.exitCode = 1;
  }
}

main();
