import test from 'node:test';import assert from 'node:assert/strict';
import {validateInput,normalizeOutput,requestAI,createServer} from './server.mjs';
const catalog=[{id:1,name:'Vodka',category:'LIQUOR',unit:'bottle',quantity:2.25,counted:true,low_stock:1},{id:2,name:'Cola',category:'CANNED DRINKS',unit:'can',quantity:24,counted:true,low_stock:12}];
const input=validateInput({kind:'ideas',inventory:catalog,date:'2026-10-02',event:'VFW event',usage:[]});
test('reject invalid catalog IDs, missing photos and invalid image encodings',()=>{
 assert.throws(()=>validateInput({kind:'ideas',inventory:[...catalog,catalog[0]]}),/ID/);
 assert.throws(()=>validateInput({kind:'photo',inventory:catalog}),/JPEG/);
 assert.throws(()=>validateInput({kind:'photo',inventory:catalog,images:['https://untrusted.test/photo.jpg']}),/JPEG/);
 assert.throws(()=>validateInput({kind:'ideas',inventory:Array.from({length:201},(_,i)=>({...catalog[0],id:i+1}))}),/200/);
});
test('quarter bottle normalization, unknown IDs and negative quantities',()=>{
 const output=normalizeOutput({summary:'Review',suggestions:[{item_id:1,title:'Vodka',quantity:2.3,reason:'visible',confidence:'medium'},{item_id:999,title:'unknown',quantity:-2,confidence:'invented',reason:'unclear'}]},input);
 assert.equal(output.suggestions[0].quantity,2.25);assert.equal(output.suggestions[1].item_id,null);assert.equal(output.suggestions[1].quantity,null);assert.equal(output.suggestions[1].confidence,'low');
});
test('photo suggestions do not repeat a matched item',()=>{
 const p=validateInput({kind:'photo',inventory:catalog,images:['data:image/jpeg;base64,YWJj']});
 assert.equal(normalizeOutput({summary:'x',suggestions:[{item_id:1,title:'a',quantity:2},{item_id:1,title:'b',quantity:2}]},p).suggestions.length,1);
});
test('Responses request uses structured output and handles incomplete/refused results',async()=>{
 let sent;
 const mock=async(url,opts)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(opts.body);return {ok:true,json:async()=>({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({summary:'Review before applying',suggestions:[]})}]}]})};};
 const result=await requestAI(input,{key:'test-key-not-real',fetch:mock});assert.equal(result.summary,'Review before applying');assert.equal(sent.store,false);assert.equal(sent.text.format.strict,true);assert.equal(sent.text.format.type,'json_schema');
 await assert.rejects(()=>requestAI(input,{key:'test-key-not-real',fetch:async()=>({ok:true,json:async()=>({status:'incomplete'})})}),/incomplete/);
 await assert.rejects(()=>requestAI(input,{key:'test-key-not-real',fetch:async()=>({ok:true,json:async()=>({output:[{content:[{type:'refusal',refusal:'cannot estimate'}]}]})})}),/could not/);
});
test('HTTP service requires device token and returns reviewed suggestions only',async()=>{
 const token='test-device-token-0000000000000000';
 const server=createServer({token,key:'test-key-not-real',assist:async(i)=>({summary:'Suggestions only',suggestions:[]})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(url+'/health')).status,401);
  assert.equal((await fetch(url+'/live')).status,200);
  const headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  const health=await fetch(url+'/health',{headers});assert.equal(health.status,200);assert.equal((await health.json()).ready,true);
  assert.equal((await fetch(url+'/assist',{method:'POST',headers,body:JSON.stringify({kind:'ideas',inventory:catalog})})).status,200);
  assert.equal((await fetch(url+'/assist',{method:'POST',headers,body:'not-json'})).status,400);
  assert.equal((await fetch(url+'/stock',{method:'POST',headers,body:'{}'})).status,404);
 }finally{await new Promise(resolve=>server.close(resolve));}
});