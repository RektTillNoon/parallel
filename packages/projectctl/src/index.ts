#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const extension = process.platform === 'win32' ? '.exe' : '';
const binaryCandidates = [
  process.env.PARALLEL_PROJECTCTL_BINARY,
  path.resolve(__dirname, `../../../target/release/projectctl${extension}`),
  path.resolve(__dirname, `../../../target/debug/projectctl${extension}`),
].filter((value): value is string => Boolean(value));
const resolvedBinary = binaryCandidates.find((candidate) => fs.existsSync(candidate));

if (!resolvedBinary) {
  console.error(
    'Failed to launch Rust projectctl: native binary not found. Build the workspace first or set PARALLEL_PROJECTCTL_BINARY.',
  );
  process.exit(1);
}

const result = spawnSync(resolvedBinary, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(`Failed to launch Rust projectctl: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
