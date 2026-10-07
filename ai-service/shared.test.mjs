import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createSharedStore} from './shared.mjs';
import {createServer} from './server.mjs';
function fixture(store){const s=store.snapshot();s.employees=[{id:1,name:'Test manager',role:'Manager',pin:'9876',active:1},{id:2,name:'Test staff',role:'Staff',pin:'1234',active:1}];s.inventory_items=[{id:1,product_name:'Test food',quantity_on_hand:20,unit:'portion',counted:1}];s.pos_products=[{id:1,name:'Test sandwich',category:'FOOD',price_cents:200,kitchen:1}];s.pos_recipes=[{id:1,product_id:1,item_id:1,quantity:1}];s.cash_drawers=[{id:1,opened_at:1,opened_by:1,opened_name:'Test manager',opening_cents:10000}];return s;}
function init(store){const r=store.handle('/shared/init','POST',{snapshot:fixture(store),pin:'9876'});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
function sale(buzzer=''){return {key:crypto.randomUUID(),cart:[{product:{id:1,price:200,revision:0},quantity:1,note:'No onion'}],tendered:500,buzzer,note:'Test order'};}

test('classified employees get only their permitted reports and assigned drawer',()=>{
 const store=createSharedStore();try {
  const s=fixture(store);s.employees.push(...[['Bartender','2222'],['Office personnel','3333'],['Officer','4444'],['Security','5555']].map(([role,pin],i)=>({id:i+3,name:role,role,pin,active:1})));
  s.drawer_groups.push({id:2,drawer_key:'side',name:'Side bar',printer_host:'192.168.1.20',printer_port:9100,drawer_pin:1,auto_open:1});
  s.cash_drawers.push({id:2,opened_at:2,opened_by:1,opened_name:'Test manager',opening_cents:5000,drawer_key:'side'});
  const admin=store.handle('/shared/init','POST',{snapshot:s,pin:'9876'}).body;
  const device_id='role-testing-register-0001';assert.equal(store.handle('/shared/register','POST',{device_id},admin.session).status,200);
  const bar=store.handle('/shared/login','POST',{pin:'2222'}).body.session;
  const office=store.handle('/shared/login','POST',{pin:'3333'}).body.session;
  const officer=store.handle('/shared/login','POST',{pin:'4444'}).body.session;
  assert.ok(bar&&office&&officer);assert.equal(store.handle('/shared/login','POST',{pin:'5555'}).status,400);
  for(const session of [bar,office]) {
   assert.equal(store.handle('/shared/snapshot','GET',{},session).status,400);
   assert.equal(store.handle('/shared/register','POST',{device_id},session).status,400);
   assert.equal(store.handle('/shared/save','POST',{},session).status,400);
  }
  assert.equal(store.handle('/shared/snapshot','GET',{},officer).status,200);
  const periods=store.handle('/shared/reports/cash','POST',{device_id},bar);assert.equal(periods.status,200);assert.deepEqual(periods.body.periods.map(d=>d.id),[1]);
  assert.equal(store.handle('/shared/reports/cash','POST',{device_id,id:2},bar).status,400);
  assert.equal(store.handle('/shared/reports/cash','POST',{device_id},office).status,400);
  assert.equal(store.handle('/shared/reports/time','POST',{start:0,end:Date.now()+1000},bar).status,400);
  store.handle('/shared/clock','POST',{pin:'5555',clockIn:true});
  const time=store.handle('/shared/reports/time','POST',{start:0,end:Date.now()+1000},office);assert.equal(time.status,200);assert.equal(time.body.shifts.length,1);
  assert.equal(time.body.employees,undefined);assert.equal(time.body.inventory_items,undefined);assert.ok(!JSON.stringify(time.body).includes('5555'));
  const current=store.handle('/shared/reports/cash','POST',{device_id},bar).body;
  assert.equal(store.handle('/shared/reports/close','POST',{device_id,id:2,counted:5000,revision:current.revision},bar).status,400);
  const close={device_id,id:1,counted:10000,revision:current.revision};assert.equal(store.handle('/shared/reports/close','POST',close,bar).status,200);assert.equal(store.handle('/shared/reports/close','POST',close,bar).status,200);
  assert.equal(store.snapshot().journal.filter(j=>j.event_type==='DRAWER CLOSED').length,1);
  const report=store.handle('/shared/reports/cash','POST',{device_id,id:1},bar).body.lines;assert.ok(report.some(l=>l.includes('Z REPORT')));
  const routing=store.handle('/shared/public','GET').body.drawers.find(d=>d.key==='side');assert.equal(routing.printer_host,'192.168.1.20');assert.equal(routing.drawer_pin,1);
  const state=store.handle('/shared/snapshot','GET',{},admin.session).body;state.snapshot.employees.find(e=>e.role==='Bartender').role='Security';assert.equal(store.handle('/shared/save','POST',{key:crypto.randomUUID(),...state},admin.session).status,200);
  assert.equal(store.handle('/shared/session','GET',{},bar).status,400);
 }finally {store.close();}
});
test('several register sales share one drawer and stock, retries do not duplicate',()=>{const store=createSharedStore();try{init(store);const orders=[sale('12'),sale('13'),sale('14')];for(const o of orders)assert.equal(store.handle('/shared/checkout','POST',o).status,200);const repeat=store.handle('/shared/checkout','POST',orders[0]);assert.equal(repeat.body.id,1);const snapshot=store.snapshot();assert.equal(snapshot.sales.length,3);assert.equal(snapshot.cash_entries.reduce((n,x)=>n+x.amount_cents,0),600);assert.equal(snapshot.inventory_items[0].quantity_on_hand,17);assert.equal(store.handle('/shared/checkout','POST',sale('012')).status,400);assert.equal(store.snapshot().sales.length,3);const pub=store.handle('/shared/public','GET').body;assert.equal(pub.kitchen.length,3);assert.equal(pub.kitchen[0].total,0);assert.equal(pub.kitchen[0].items[0].price,0);assert.equal(pub.employees,undefined);}finally{store.close();}});
test('manager snapshot saves conflict with later sales; incorrect and staff PINs have no manager access',()=>{const store=createSharedStore();try{const m=init(store);assert.equal(store.handle('/shared/login','POST',{pin:'1234'}).status,400);assert.equal(store.handle('/shared/snapshot','GET').status,400);const snap=store.handle('/shared/snapshot','GET',{},m.session).body;store.handle('/shared/checkout','POST',sale());assert.equal(store.handle('/shared/save','POST',{key:crypto.randomUUID(),revision:snap.revision,snapshot:snap.snapshot},m.session).status,409);assert.equal(store.snapshot().sales.length,1);const current=store.handle('/shared/snapshot','GET',{},m.session).body;current.snapshot.pos_products[0].name='Updated sandwich';const body={key:crypto.randomUUID(),revision:current.revision,snapshot:current.snapshot};assert.equal(store.handle('/shared/save','POST',body,m.session).status,200);assert.equal(store.handle('/shared/save','POST',body,m.session).status,200);assert.equal(store.snapshot().sales.length,1);}finally{store.close();}});
test('kitchen status and employee punches are shared and validated',()=>{const store=createSharedStore();try{init(store);const r=store.handle('/shared/checkout','POST',sale('4')).body;assert.equal(store.handle('/shared/kitchen','POST',{id:r.id,expected:'NEW',next:'PREPARING'}).status,200);assert.equal(store.handle('/shared/public','GET').body.kitchen[0].status,'PREPARING');assert.equal(store.handle('/shared/kitchen','POST',{id:r.id,expected:'NEW',next:'READY'}).status,400);assert.equal(store.handle('/shared/clock','POST',{pin:'1234',clockIn:true}).status,200);assert.equal(store.handle('/shared/clock','POST',{pin:'1234',clockIn:true}).status,400);assert.equal(store.handle('/shared/clock','POST',{pin:'1234',clockIn:false}).status,200);assert.equal(store.snapshot().time_shifts.length,1);assert.ok(store.snapshot().time_shifts[0].clock_out);}finally{store.close();}});
test('records survive process reopen and bad imports roll back',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'barpos-shared-test-'));const filename=path.join(dir,'records.sqlite');let store=createSharedStore({filename});try{init(store);store.handle('/shared/checkout','POST',sale());store.close();store=createSharedStore({filename});assert.equal(store.snapshot().sales.length,1);const m=store.handle('/shared/login','POST',{pin:'9876'}).body;const s=store.handle('/shared/snapshot','GET',{},m.session).body;s.snapshot.pos_recipes[0].item_id=999;assert.equal(store.handle('/shared/save','POST',{key:crypto.randomUUID(),...s},m.session).status,400);assert.equal(store.snapshot().pos_recipes[0].item_id,1);assert.equal(store.snapshot().sales.length,1);}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}});
test('HTTP routes require the device token and work without an AI provider key',async()=>{const store=createSharedStore();const token='fake-shared-device-token-for-tests';const server=createServer({token,shared:store,key:''});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const url='http://127.0.0.1:'+server.address().port;assert.equal((await fetch(url+'/shared/public')).status,401);const pub=await fetch(url+'/shared/public',{headers:{Authorization:'Bearer '+token}});assert.equal(pub.status,200);assert.equal((await pub.json()).ready,false);}finally{await new Promise(resolve=>server.close(resolve));store.close();}});
test('five concurrent HTTP register requests and their retries record five sales exactly',async()=>{const store=createSharedStore();init(store);const token='fake-shared-device-token-for-tests';const server=createServer({token,shared:store,key:''});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const url='http://127.0.0.1:'+server.address().port;const orders=Array.from({length:5},(_,i)=>sale(String(i+1)));const responses=await Promise.all([...orders,...orders].map(async body=>{const response=await fetch(url+'/shared/checkout',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json();}));assert.equal(new Set(responses.map(x=>x.id)).size,5);assert.equal(store.snapshot().sales.length,5);assert.equal(store.snapshot().cash_entries.reduce((n,x)=>n+x.amount_cents,0),1000);assert.equal(store.snapshot().inventory_items[0].quantity_on_hand,15);}finally{await new Promise(resolve=>server.close(resolve));store.close();}});
test('shared and assigned drawers isolate totals and reject stale assignments',()=>{const store=createSharedStore();try{const m=init(store);const ids=['register-device-00000001','register-device-00000002','register-device-00000003'];for(const device_id of ids)assert.equal(store.handle('/shared/register','POST',{device_id},m.session).status,200);let state=store.handle('/shared/snapshot','GET',{},m.session).body;state.snapshot.drawer_groups.push({id:2,drawer_key:'side',name:'Side bar'});state.snapshot.cash_drawers.push({id:2,opened_at:2,opened_by:1,opened_name:'Test manager',opening_cents:5000,drawer_key:'side'});state.snapshot.tablet_assignments[2].drawer_key='side';assert.equal(store.handle('/shared/save','POST',{key:crypto.randomUUID(),...state},m.session).status,200);for(let i=0;i<3;i++){const result=store.handle('/shared/checkout','POST',{...sale(String(10+i)),device_id:ids[i],drawer_key:i===2?'side':'main'});assert.equal(result.status,200);assert.equal(result.body.drawer_name,i===2?'Side bar':'Main bar drawer');}const snapshot=store.snapshot();assert.equal(snapshot.cash_entries.filter(x=>x.drawer_id===1).reduce((n,x)=>n+x.amount_cents,0),400);assert.equal(snapshot.cash_entries.filter(x=>x.drawer_id===2).reduce((n,x)=>n+x.amount_cents,0),200);assert.equal(snapshot.inventory_items[0].quantity_on_hand,17);state=store.handle('/shared/snapshot','GET',{},m.session).body;state.snapshot.tablet_assignments[0].drawer_key='side';assert.equal(store.handle('/shared/save','POST',{key:crypto.randomUUID(),...state},m.session).status,200);assert.equal(store.handle('/shared/checkout','POST',{...sale('44'),device_id:ids[0],drawer_key:'main'}).status,400);assert.equal(store.snapshot().sales.length,3);assert.equal(store.handle('/shared/register','POST',{device_id:'unauthorized-register-0001'}).status,400);}finally{store.close();}});
test('existing version 9 disk migration preserves history and the original open drawer',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'barpos-migration-test-'));const filename=path.join(dir,'old.sqlite');const old=new DatabaseSync(filename);old.exec(fs.readFileSync(new URL('./shared-schema.sql',import.meta.url),'utf8'));old.exec("INSERT INTO employees(id,name,role,pin) VALUES(1,'Test manager','Manager','9876'); INSERT INTO cash_drawers(id,opened_at,opened_by,opened_name,opening_cents) VALUES(7,1234,1,'Test manager',4321);");old.close();const store=createSharedStore({filename});try{const s=store.snapshot();assert.equal(s.format,'barpos-backup-12');assert.equal(s.cash_drawers[0].id,7);assert.equal(s.cash_drawers[0].opening_cents,4321);assert.equal(s.cash_drawers[0].drawer_key,'main');assert.equal(s.employees[0].pin,'9876');assert.equal(store.handle('/shared/public','GET').body.drawer_open,true);}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}});

test('first public sale opens assigned period once with entered float, rollback and retries preserve totals',()=>{
 const store=createSharedStore();try {
  const snapshot=fixture(store);snapshot.cash_drawers=[];const admin=store.handle('/shared/init','POST',{snapshot,pin:'9876'}).body;
  const device_id='public-register-test-00001';assert.equal(store.handle('/shared/register','POST',{device_id},admin.session).status,200);
  const body={...sale(),device_id,drawer_key:'main',opening_cash:10000};
  assert.equal(store.handle('/shared/checkout','POST',{...body,tendered:1}).status,400);
  assert.equal(store.snapshot().cash_drawers.length,0);assert.equal(store.snapshot().journal.filter(j=>j.event_type==='DRAWER OPEN').length,0);
  assert.equal(store.handle('/shared/checkout','POST',{...body,opening_cash:null}).status,400);
  const paid=store.handle('/shared/checkout','POST',body);assert.equal(paid.status,200,JSON.stringify(paid));
  assert.equal(store.handle('/shared/checkout','POST',body).body.id,paid.body.id);
  assert.equal(store.handle('/shared/checkout','POST',{...sale(),device_id,drawer_key:'main',opening_cash:50000}).status,200);
  const state=store.snapshot();assert.equal(state.cash_drawers.length,1);assert.equal(state.cash_drawers[0].opening_cents,10000);assert.equal(state.cash_drawers[0].opened_by,null);assert.equal(state.sales.length,2);
  assert.equal(state.journal.filter(j=>j.event_type==='DRAWER OPEN').length,1);
  const report=store.handle('/shared/reports/cash','POST',{device_id,id:state.cash_drawers[0].id},admin.session);assert.ok(report.body.lines.includes('EXPECTED CASH: $104.00'));
  const stale={...sale(),device_id,drawer_key:'main',opening_cash:10000};
  const current=store.handle('/shared/reports/cash','POST',{device_id},admin.session).body;
  assert.equal(store.handle('/shared/reports/close','POST',{device_id,id:state.cash_drawers[0].id,counted:10400,revision:current.revision},admin.session).status,200);
  assert.equal(store.handle('/shared/checkout','POST',{...stale,opening_cash:null}).status,400);
  assert.equal(store.handle('/shared/checkout','POST',{...stale,opening_cash:0}).status,200);
  assert.equal(store.snapshot().cash_drawers.length,2);assert.equal(store.snapshot().cash_drawers[0].expected_cents,10400);
 }finally{store.close();}
});
