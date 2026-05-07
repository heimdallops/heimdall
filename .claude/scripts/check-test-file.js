#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { normalize, sep } from 'node:path';

const data = JSON.parse(readFileSync(0, 'utf-8'));
const filePath = data?.tool_input?.file_path ?? '';

const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__']);
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

function isTestFile(fp) {
  if (!fp) return false;
  const segments = normalize(fp).split(sep);
  return segments.some((s) => TEST_DIR_NAMES.has(s)) || TEST_FILE_RE.test(fp);
}

const [, , mode] = process.argv;

if (mode === '--block-tests') {
  if (isTestFile(filePath)) {
    process.stderr.write(`BLOCKED: ts-engineer does not modify test files. Path: ${filePath}\n`);
    process.stderr.write('Use a testing-focused agent for test file changes.\n');
    process.exit(2);
  }
} else if (mode === '--require-tests') {
  if (!isTestFile(filePath)) {
    process.stderr.write(`BLOCKED: ts-tester only modifies test files. Path: ${filePath}\n`);
    process.stderr.write(
      'Report production code issues to the user or a production-code agent instead.\n'
    );
    process.exit(2);
  }
} else {
  process.stderr.write(`Unknown mode: ${mode}. Use --block-tests or --require-tests.\n`);
  process.exit(1);
}
