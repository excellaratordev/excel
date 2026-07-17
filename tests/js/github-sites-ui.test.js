'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '../..');
const script = fs.readFileSync(path.join(root, 'static/js/github-connector.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'static/css/github-sites.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.py'), 'utf8');

test('painel GitHub publica botão de abrir site e links por HTML', () => {
  assert.match(script, /github-open-site/);
  assert.match(script, /github-file-open/);
  assert.match(script, /\/api\/github\/site\?project_id=/);
  assert.match(script, /Subdomínio ativo/);
  assert.match(script, /Prévia disponível/);
});

test('interface de publicação possui layout responsivo próprio', () => {
  assert.match(styles, /\.github-site-panel/);
  assert.match(styles, /\.github-file-open/);
  assert.match(styles, /@media \(max-width: 680px\)/);
});

test('hosting de subdomínio é instalado antes da proteção da API principal', () => {
  const hosting = app.indexOf('install_github_site_hosting(app)');
  const auth = app.indexOf('app.before_request(protect_api_routes)');
  assert.ok(hosting >= 0 && auth > hosting);
  assert.match(app, /register_blueprint\(github_sites_api\)/);
});
