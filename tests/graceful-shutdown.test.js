const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fork } = require('node:child_process');
const path = require('node:path');

process.env.AUTH_MODE = 'local';
process.env.LOCAL_USERS = 'admin:password123';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';
process.env.PORT = '0'; // Use random port

const { app, server, gracefulShutdown } = require('../server');

test('gracefulShutdown is exported as a function', () => {
  assert.equal(typeof gracefulShutdown, 'function');
});

test('SIGTERM and SIGINT handlers are registered', () => {
  const sigtermListeners = process.listeners('SIGTERM');
  const sigintListeners = process.listeners('SIGINT');
  assert.ok(sigtermListeners.length > 0, 'should have SIGTERM handler');
  assert.ok(sigintListeners.length > 0, 'should have SIGINT handler');
});

test('graceful shutdown via SIGTERM signal (integration)', async () => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Graceful shutdown timed out'));
    }, 15000);

    const env = {
      ...process.env,
      PORT: '0',
      AUTH_MODE: 'local',
      LOCAL_USERS: 'admin:password123',
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
    };

    const child = fork(
      path.join(__dirname, '..', 'server.js'),
      [],
      { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }
    );

    let exited = false;
    let shutdownComplete = false;

    child.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Graceful shutdown complete')) {
        shutdownComplete = true;
      }
    });

    child.stderr.on('data', () => {
      // ignore stderr for this test
    });

    child.on('exit', (code) => {
      if (exited) return;
      exited = true;
      clearTimeout(timeout);
      if (shutdownComplete && code === 0) {
        resolve();
      } else {
        reject(new Error(`Child process exited with code ${code}, shutdownComplete=${shutdownComplete}`));
      }
    });

    // Wait for server to start, then send SIGTERM
    setTimeout(() => {
      if (!exited) {
        child.kill('SIGTERM');
      }
    }, 3000);
  });
});

test('graceful shutdown via SIGINT signal (integration)', async () => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Graceful shutdown timed out'));
    }, 15000);

    const env = {
      ...process.env,
      PORT: '0',
      AUTH_MODE: 'local',
      LOCAL_USERS: 'admin:password123',
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
    };

    const child = fork(
      path.join(__dirname, '..', 'server.js'),
      [],
      { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }
    );

    let exited = false;
    let shutdownComplete = false;

    child.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Graceful shutdown complete')) {
        shutdownComplete = true;
      }
    });

    child.stderr.on('data', () => {
      // ignore stderr for this test
    });

    child.on('exit', (code) => {
      if (exited) return;
      exited = true;
      clearTimeout(timeout);
      if (shutdownComplete && code === 0) {
        resolve();
      } else {
        reject(new Error(`Child process exited with code ${code}, shutdownComplete=${shutdownComplete}`));
      }
    });

    // Wait for server to start, then send SIGINT
    setTimeout(() => {
      if (!exited) {
        child.kill('SIGINT');
      }
    }, 3000);
  });
});