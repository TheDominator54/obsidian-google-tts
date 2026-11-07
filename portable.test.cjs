const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
test('bundled helper runs outside the original Codex installation without credentials',()=>{
 const source=fs.readFileSync(__dirname+'/main.js','utf8');
 assert.ok(!source.includes('/Users/dom/'));
 const helper=JSON.parse(source.match(/^const BUNDLED_HELPER = (.*);$/m)[1]);
 const result=spawnSync('/opt/homebrew/bin/python3',['-c',helper,'synthesize','--help'],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/--input-file/);
});
