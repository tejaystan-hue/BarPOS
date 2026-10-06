import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import crypto from 'node:crypto';
const tables=['employees','inventory_items','inventory_movements','inventory_work','sales','sale_items','journal','weekly_counts','weekly_lines','count_drafts','delivery_orders','delivery_receipts','recount_checks','board_notes','time_shifts','pos_products','pos_recipes','cash_drawers','cash_entries','sale_stock','sale_reversals','time_changes','drawer_groups','tablet_assignments'];
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const text=(x,max)=>typeof x==='string'?x.trim().slice(0,max):'';
const validCents=x=>Number.isSafeInteger(x)&&x>=0&&x<=100000000;
export function createSharedStore({filename=':memory:'}={}) {
 const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
 if(!db.prepare("SELECT name FROM sqlite_master WHERE name='employees'").get())db.exec(fs.readFileSync(new URL('./shared-schema.sql',import.meta.url),'utf8'));
 db.exec("CREATE TABLE IF NOT EXISTS drawer_groups(id INTEGER PRIMARY KEY AUTOINCREMENT,drawer_key TEXT UNIQUE NOT NULL,name TEXT NOT NULL); INSERT OR IGNORE INTO drawer_groups(id,drawer_key,name) VALUES(1,'main','Main bar drawer'); CREATE TABLE IF NOT EXISTS tablet_assignments(id INTEGER PRIMARY KEY AUTOINCREMENT,device_id TEXT UNIQUE NOT NULL,name TEXT NOT NULL,drawer_key TEXT NOT NULL REFERENCES drawer_groups(drawer_key));");
 const upgraded=!db.prepare('PRAGMA table_info(cash_drawers)').all().some(x=>x.name==='drawer_key');
 if(upgraded)db.exec("ALTER TABLE cash_drawers ADD COLUMN drawer_key TEXT NOT NULL DEFAULT 'main' REFERENCES drawer_groups(drawer_key)");
 db.exec('DROP INDEX IF EXISTS single_open_drawer; CREATE UNIQUE INDEX IF NOT EXISTS one_open_drawer_per_group ON cash_drawers(drawer_key) WHERE closed_at IS NULL;');
 db.exec('CREATE TABLE IF NOT EXISTS cloud_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT OR IGNORE INTO cloud_meta VALUES(1,0); CREATE TABLE IF NOT EXISTS cloud_writes(id TEXT PRIMARY KEY,digest TEXT NOT NULL,revision INTEGER NOT NULL);');
 if(upgraded&&db.prepare('SELECT id FROM employees LIMIT 1').get())db.exec('UPDATE cloud_meta SET revision=revision+1 WHERE id=1');
 const sessions=new Map();
 const revision=()=>db.prepare('SELECT revision FROM cloud_meta WHERE id=1').get().revision;
 const ready=()=>Boolean(db.prepare('SELECT id FROM employees LIMIT 1').get());
 const row=(sql,...args)=>db.prepare(sql).get(...args);
 const rows=(sql,...args)=>db.prepare(sql).all(...args);
 const run=(sql,...args)=>db.prepare(sql).run(...args);
 const insert=(table,values)=>{const keys=Object.keys(values);return run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...Object.values(values)).lastInsertRowid;};
 const bump=()=>run('UPDATE cloud_meta SET revision=revision+1 WHERE id=1');
 function transaction(work) {db.exec('BEGIN IMMEDIATE');try {const result=work();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
 const journal=(type,details,name='Shared register',employeeId=null,saleId=null,amount=null)=>insert('journal',{employee_name:name,employee_id:employeeId,sale_id:saleId,event_type:type,details,amount,created_at:Date.now()});
 const openDrawer=(key='main')=>row('SELECT * FROM cash_drawers WHERE closed_at IS NULL AND drawer_key=?',key);
 const manager=token=>{const session=sessions.get(token);requireValue(session&&session.until>Date.now(),'Manager session expired. Log in again.');const actor=row("SELECT id,name,role,active FROM employees WHERE id=? AND active=1 AND role='Manager'",session.id);requireValue(actor,'Manager access ended.');return actor;};
 function login(pin) {requireValue(/^[0-9]{4}$/.test(pin),'Enter a four-digit manager PIN.');const actor=row("SELECT id,name,role,active FROM employees WHERE pin=? AND active=1 AND role='Manager'",pin);requireValue(actor,'Manager PIN not recognized.');const session=crypto.randomBytes(32).toString('hex');sessions.set(session,{id:actor.id,until:Date.now()+8*3600000});return {actor:{...actor,active:true},session};}
 function snapshot() {const result={format:'barpos-backup-10',created_at:Date.now()};for(const table of tables)result[table]=rows('SELECT * FROM '+table+' ORDER BY id');return result;}
 function importSnapshot(data) {
  if(data?.format==='barpos-backup-9')data={...data,format:'barpos-backup-10',drawer_groups:[{id:1,drawer_key:'main',name:'Main bar drawer'}],tablet_assignments:[]};
  requireValue(data?.format==='barpos-backup-10','Use a current BarPOS backup.');
  for(const table of tables){requireValue(Array.isArray(data[table])&&data[table].length<=200000,'Incomplete or oversized snapshot: '+table);}
  for(const table of [...tables].reverse())run('DELETE FROM '+table);
  for(const table of tables){const allowed=new Set(rows('PRAGMA table_info('+table+')').map(x=>x.name));for(const item of data[table]){requireValue(item&&Object.keys(item).length>0&&Object.keys(item).every(k=>allowed.has(k)),'Unexpected snapshot fields.');requireValue(Object.values(item).every(v=>v===null||typeof v==='string'||typeof v==='number'&&Number.isFinite(v)),'Invalid snapshot value.');insert(table,item);}}
  requireValue(rows('PRAGMA foreign_key_check').length===0,'Snapshot has broken references.');
  requireValue(row("SELECT id FROM employees WHERE active=1 AND role='Manager'"),'At least one active manager is required.');
 }
 function receipt(id,kitchenOnly=false) {
  const s=row('SELECT * FROM sales WHERE id=?',id);requireValue(s,'Sale not found.');
  const reversal=row('SELECT * FROM sale_reversals WHERE sale_id=?',id);
  return {id:s.id,drawer_name:row('SELECT g.name FROM cash_drawers d JOIN drawer_groups g ON g.drawer_key=d.drawer_key WHERE d.id=?',s.drawer_id)?.name??'',total:kitchenOnly?0:s.total_cents??Math.round(s.total*100),tendered:kitchenOnly?0:s.tendered_cents??Math.round(s.cash_tendered*100),at:s.completed_at,buzzer:s.buzzer,note:s.order_note,status:s.kitchen_status,
   items:rows('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id',id).filter(x=>!kitchenOnly||x.kitchen===1).map(x=>({name:x.product_name,quantity:x.quantity,price:kitchenOnly?0:x.price_cents??Math.round(x.unit_price*100),kitchen:x.kitchen===1,note:x.note})),reversal:reversal?`${reversal.kind} by ${reversal.manager_name}: ${reversal.reason}`:null};
 }
 function publicState(){return {ready:ready(),revision:revision(),drawer_open:Boolean(openDrawer()),drawers:rows('SELECT * FROM drawer_groups ORDER BY id').map(g=>({key:g.drawer_key,name:g.name,open:Boolean(openDrawer(g.drawer_key))})),tablets:rows('SELECT device_id,name,drawer_key FROM tablet_assignments ORDER BY id'),menu:rows('SELECT * FROM pos_products WHERE active=1 ORDER BY category,name,id').map(x=>({id:x.id,name:x.name,category:x.category,price:x.price_cents,kitchen:x.kitchen===1,active:true,revision:x.revision})),kitchen:rows("SELECT id FROM sales WHERE kitchen_status IN ('NEW','PREPARING','READY') ORDER BY id").map(x=>receipt(x.id,true))};}
 function checkout(body) {
  requireValue(text(body.key,100).length>=20,'Invalid checkout key.');
  const duplicate=row('SELECT id FROM sales WHERE checkout_key=?',body.key);if(duplicate)return receipt(duplicate.id);
  const cart=body.cart;requireValue(Array.isArray(cart)&&cart.length>0&&cart.length<=100,'Check order items.');
  const station=body.device_id?row('SELECT * FROM tablet_assignments WHERE device_id=?',body.device_id):null;
  if(body.device_id)requireValue(station,'A manager must set up this tablet first.');
  const drawerKey=station?.drawer_key??'main';if(body.device_id)requireValue(body.drawer_key===drawerKey,'Drawer assignment changed. Refresh and review where to take cash.');
  const d=openDrawer(drawerKey);requireValue(d,'A manager must open this tablet\'s assigned cash drawer first.');
  let total=0;const lines=cart.map(x=>{const p=row('SELECT * FROM pos_products WHERE id=? AND active=1',x.product?.id);requireValue(p&&p.revision===x.product.revision&&p.price_cents===x.product.price,'Menu changed. Remove this item and add it again.');requireValue(Number.isInteger(x.quantity)&&x.quantity>0&&x.quantity<=999,'Invalid quantity.');requireValue(typeof x.note==='string'&&x.note.length<=300,'Note is too long.');total+=p.price_cents*x.quantity;return {p,quantity:x.quantity,note:x.note.trim()};});
  requireValue(validCents(total)&&validCents(body.tendered)&&body.tendered>=total,'Cash must cover the total.');
  const kitchen=lines.some(x=>x.p.kitchen===1);requireValue(typeof body.buzzer==='string'&&body.buzzer.length<=4,'Buzzer must be 1 to 9999.');const number=body.buzzer.trim();requireValue(!number||/^[0-9]{1,4}$/.test(number)&&Number(number)>0,'Buzzer must be 1 to 9999.');const buzzer=number?String(Number(number)):'';
  requireValue(typeof body.note==='string'&&body.note.length<=500,'Order note is too long.');
  if(kitchen&&buzzer)requireValue(!row("SELECT id FROM sales WHERE buzzer=? AND kitchen_status IN ('NEW','PREPARING','READY')",buzzer),'This buzzer is already on an open ticket.');
  const now=Date.now();const sale=insert('sales',{employee_name:'Shared register',employee_role:'Shared register',total:total/100,cash_tendered:body.tendered/100,change_due:(body.tendered-total)/100,completed_at:now,drawer_id:d.id,total_cents:total,tendered_cents:body.tendered,buzzer:kitchen?buzzer:'',order_note:body.note.trim(),kitchen_status:kitchen?'NEW':'NONE',checkout_key:body.key});
  const stock=new Map();for(const line of lines){insert('sale_items',{sale_id:sale,product_id:line.p.id,product_name:line.p.name,quantity:line.quantity,unit_price:line.p.price_cents/100,price_cents:line.p.price_cents,kitchen:line.p.kitchen,note:line.note});for(const part of rows('SELECT * FROM pos_recipes WHERE product_id=?',line.p.id))stock.set(part.item_id,(stock.get(part.item_id)??0)+part.quantity*line.quantity);}
  for(const [id,quantity] of stock){const item=row('SELECT * FROM inventory_items WHERE id=?',id);requireValue(item&&Number.isFinite(quantity)&&quantity>0,'Inventory link is invalid.');insert('sale_stock',{sale_id:sale,item_id:id,quantity,applied:item.counted});if(item.counted){const after=item.quantity_on_hand-quantity;requireValue(Number.isFinite(after),'Invalid stock balance.');run('UPDATE inventory_items SET quantity_on_hand=?,revision=revision+1 WHERE id=?',after,id);insert('inventory_movements',{inventory_item_id:id,quantity_delta:-quantity,reason:'SALE',employee_name:'Shared register',created_at:now,sale_id:sale,before_quantity:item.quantity_on_hand,after_quantity:after});}}
  insert('cash_entries',{drawer_id:d.id,kind:'SALE',amount_cents:total,sale_id:sale,actor_name:'Shared register',note:'Cash sale; tax included',created_at:now});journal('SALE',lines.map(x=>`${x.quantity} x ${x.p.name}`).join(', ')+`; buzzer ${buzzer||'none'}`,'Shared register',null,sale,total/100);bump();return receipt(sale);
 }
 function clock(body) {
  requireValue(/^[0-9]{4}$/.test(body.pin),'Enter your four-digit employee PIN.');const e=row('SELECT * FROM employees WHERE pin=? AND active=1',body.pin);requireValue(e,'PIN not recognized.');const open=row('SELECT * FROM time_shifts WHERE employee_id=? AND clock_out IS NULL',e.id);const now=Date.now();
  if(body.clockIn===true){requireValue(!open,'Already clocked in.');const last=row('SELECT MAX(clock_out) AS last FROM time_shifts WHERE employee_id=?',e.id);requireValue(last.last===null||now>=last.last,'Server clock is earlier than last clock-out.');insert('time_shifts',{employee_id:e.id,employee_name:e.name,clock_in:now});}
  else {requireValue(body.clockIn===false&&open,'Not clocked in.');requireValue(now>=open.clock_in,'Clock-out must follow clock-in.');run('UPDATE time_shifts SET clock_out=? WHERE id=?',now,open.id);}
  journal(body.clockIn?'CLOCK IN':'CLOCK OUT','Employee time-clock punch',e.name,e.id);bump();return {message:`${e.name} clocked ${body.clockIn?'in':'out'}.`};
 }
 return {close:()=>db.close(),snapshot,handle(path,method,body={},session='') {
  try {
   if(path==='/shared/public'&&method==='GET')return {status:200,body:publicState()};
   if(path==='/shared/init'&&method==='POST'){requireValue(!ready(),'Shared records already exist.');const result=transaction(()=>{importSnapshot(body.snapshot);bump();return login(body.pin);});return {status:200,body:{...result,revision:revision(),snapshot:snapshot()}};}
   requireValue(ready(),'Set up shared records from the manager tablet first.');
   if(path==='/shared/login'&&method==='POST')return {status:200,body:login(body.pin)};
   if(path==='/shared/register'&&method==='POST'){const actor=manager(session);requireValue(typeof body.device_id==='string'&&/^[a-zA-Z0-9-]{20,80}$/.test(body.device_id),'Invalid tablet identifier.');transaction(()=>{if(!row('SELECT id FROM tablet_assignments WHERE device_id=?',body.device_id)){insert('tablet_assignments',{device_id:body.device_id,name:'Tablet '+body.device_id.slice(0,4),drawer_key:'main'});journal('TABLET REGISTERED','Tablet '+body.device_id.slice(0,4)+' assigned to main drawer',actor.name,actor.id);bump();}});return {status:200,body:{ok:true}};}
   if(path==='/shared/snapshot'&&method==='GET'){manager(session);return {status:200,body:{revision:revision(),snapshot:snapshot()}};}
   if(path==='/shared/save'&&method==='POST'){const actor=manager(session);requireValue(text(body.key,100).length>=20,'Invalid save key.');const digest=hash(JSON.stringify(body.snapshot));const prior=row('SELECT * FROM cloud_writes WHERE id=?',body.key);if(prior){requireValue(prior.digest===digest,'Save key was reused.');return {status:200,body:{revision:prior.revision}};}
    requireValue(body.snapshot?.format==='barpos-backup-10','Update this tablet before editing shared records.');
    if(body.revision!==revision())return {status:409,body:{error:'Shared records changed on another tablet. Refresh and retry this edit.'}};
    transaction(()=>{importSnapshot(body.snapshot);requireValue(row("SELECT id FROM employees WHERE id=? AND active=1 AND role='Manager'",actor.id),'Your manager access cannot be removed during this save.');bump();insert('cloud_writes',{id:body.key,digest,revision:revision()});});return {status:200,body:{revision:revision()}};}
   if(path==='/shared/checkout'&&method==='POST')return {status:200,body:transaction(()=>checkout(body))};
   if(path==='/shared/clock'&&method==='POST')return {status:200,body:transaction(()=>clock(body))};
   if(path==='/shared/kitchen'&&method==='POST'){requireValue([['NEW','PREPARING'],['PREPARING','READY'],['READY','SERVED']].some(([a,b])=>a===body.expected&&b===body.next),'Invalid kitchen step.');transaction(()=>{const result=run("UPDATE sales SET kitchen_status=?,kitchen_updated=? WHERE id=? AND kitchen_status=? AND NOT EXISTS(SELECT 1 FROM sale_reversals WHERE sale_id=sales.id)",body.next,Date.now(),body.id,body.expected);requireValue(result.changes===1,'Ticket changed. Refresh.');journal('KITCHEN '+body.next,'Ticket #'+body.id,'Kitchen station',null,body.id);bump();});return {status:200,body:{ok:true}};}
   if(path==='/shared/receipt'&&method==='POST'){manager(session);return {status:200,body:receipt(body.id)};}
   return {status:404,body:{error:'Not found.'}};
  }catch(e){return {status:400,body:{error:e.message}};}
 }};
}
