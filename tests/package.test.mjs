import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('standalone editor bundles gallery code and no external local script references',()=>{const html=fs.readFileSync(new URL('../dist/slide-studio.html',import.meta.url),'utf8');assert.ok(html.includes('async function showGallery'));assert.doesNotMatch(html,/<script src="(?:app|advanced|library)\.js"/);assert.doesNotThrow(()=>new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));});
