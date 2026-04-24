#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TOKEN = 'parallel-smoke-token';
const READY_TIMEOUT_MS = 8_000;

export function parseReadyPort(output) {
  const match = output.match(/AGENT_BRIDGE_READY\s+(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function buildServeArgs(indexDb, root, token = TOKEN) {
  return [
    'mcp',
    'serve-http',
    '--port',
    '0',
    '--token',
    token,
    '--index-db',
    indexDb,
    '--roots',
    root,
  ];
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function resolveProjectctlBinary() {
  return (
    readFlag('--projectctl') ??
    process.env.PROJECTCTL_BINARY ??
    path.resolve(process.cwd(), 'target/debug/projectctl')
  );
}

function waitForReady(child) {
  let buffer = '';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`projectctl did not report AGENT_BRIDGE_READY within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    function inspect(chunk) {
      buffer += chunk.toString();
      const port = parseReadyPort(buffer);
      if (port) {
        clearTimeout(timeout);
        resolve(port);
      }
    }

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`projectctl exited before ready: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
  });
}

async function assertJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function runSmoke() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'parallel-bridge-smoke-'));
  const indexDb = path.join(tempRoot, 'workflow-index.sqlite');
  const projectctl = resolveProjectctlBinary();
  const child = spawn(projectctl, buildServeArgs(indexDb, tempRoot), {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const port = await waitForReady(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    await assertJsonResponse(
      await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      'health',
    );

    const payload = await assertJsonResponse(
      await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      }),
      'tools/list',
    );
    const toolNames = new Set((payload.result?.tools ?? []).map((tool) => tool.name));
    for (const required of ['record_execution', 'log_progress', 'ensure_session']) {
      if (!toolNames.has(required)) {
        throw new Error(`tools/list did not include ${required}`);
      }
    }

    console.log(`Bridge smoke passed on ${baseUrl}`);
  } finally {
    child.kill();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
