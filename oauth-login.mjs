#!/usr/bin/env node
// One-time OAuth login for the ghidra-mcp daemon (authorization_code + PKCE).
// Opens a browser to ghidra.typeguru.nl/authorize; you log in with the password.
// On success writes .ghidra-token.json and prints the access token.

import crypto from 'node:crypto';
import http from 'node:http';
import { exec } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ISSUER = 'https://ghidra.typeguru.nl';
const SCOPE = 'ghidra';
const CB_PORT = 8765;
const REDIRECT = `http://127.0.0.1:${CB_PORT}/callback`;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

async function jpost(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return r.json();
}

const reg = await jpost(`${ISSUER}/register`, {
  client_name: 'd2gs-ghidra2cpp',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: SCOPE,
});
const clientId = reg.client_id;
console.error(`Registered client ${clientId}`);

const authUrl = `${ISSUER}/authorize?` + new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: SCOPE,
  state,
}).toString();

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, REDIRECT);
    if (!u.pathname.startsWith('/callback')) { res.writeHead(404); res.end(); return; }
    const c = u.searchParams.get('code');
    const s = u.searchParams.get('state');
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>${err ? 'Auth failed: ' + err : 'Authorized — you can close this tab.'}</h2>`);
    server.close();
    if (err) return reject(new Error(err));
    if (s !== state) return reject(new Error('state mismatch'));
    resolve(c);
  });
  server.listen(CB_PORT, '127.0.0.1', () => {
    console.error(`\nOpen this URL and log in (Firefox should open automatically):\n${authUrl}\n`);
    exec(`open -a Firefox "${authUrl}"`);
  });
});

const form = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: REDIRECT,
  client_id: clientId,
  code_verifier: verifier,
});
const tr = await fetch(`${ISSUER}/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form.toString(),
});
if (!tr.ok) throw new Error(`/token -> ${tr.status} ${await tr.text()}`);
const tok = await tr.json();

writeFileSync(new URL('./.ghidra-token.json', import.meta.url), JSON.stringify({ ...tok, client_id: clientId, obtained_at: Date.now() }, null, 2));
console.error('\nSaved .ghidra-token.json');
console.error(`expires_in=${tok.expires_in}s  refresh_token=${tok.refresh_token ? 'yes' : 'no'}`);
process.stdout.write(tok.access_token + '\n');
