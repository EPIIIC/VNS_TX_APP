import test from 'node:test';
import assert from 'node:assert/strict';
import { TxClient } from './client';
import { Message,NOTIFY_UUID,Status,Sample,EcgInfo } from './protocol';
function packet(type:number,payload:Uint8Array,seq=0){
  const p=new Uint8Array(16+payload.length),v=new DataView(p.buffer);p.set([0xa7,1,type,0]);
  v.setUint16(4,seq,true);v.setUint16(6,payload.length,true);v.setBigUint64(8,1000000n,true);p.set(payload,16);return p;
}
function status(seq=0,mtu=247){const p=new Uint8Array(48),v=new DataView(p.buffer);v.setUint32(0,123,true);v.setUint32(8,7,true);v.setUint16(40,256,true);v.setUint16(42,100,true);v.setUint16(44,mtu,true);return packet(Message.STATUS,p,seq);}
function fragments(bytes:Uint8Array,mtu=247){
  const result:Uint8Array[]=[],seq=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(4,true);
  for(let offset=0;offset<bytes.length;offset+=mtu-9){
    const data=bytes.slice(offset,offset+mtu-9),p=new Uint8Array(6+data.length),v=new DataView(p.buffer);
    p.set([0xd7,1]);v.setUint16(2,seq,true);v.setUint16(4,offset,true);p.set(data,6);result.push(p);
  }return result;
}
class Characteristic extends EventTarget implements BluetoothRemoteGATTCharacteristic {
  value?:DataView; listeners=new Set<EventListenerOrEventListenerObject>(); writes:Uint8Array[]=[];reads=0;
  reader=async()=>new DataView(status().buffer);
  writer=async(_p:Uint8Array)=>{};
  starter=async()=>{};
  override addEventListener(type:string,listener:EventListenerOrEventListenerObject|null,options?:AddEventListenerOptions|boolean){
    if(type==='characteristicvaluechanged'&&listener)this.listeners.add(listener);super.addEventListener(type,listener,options);
  }
  override removeEventListener(type:string,listener:EventListenerOrEventListenerObject|null,options?:EventListenerOptions|boolean){
    if(listener)this.listeners.delete(listener);super.removeEventListener(type,listener,options);
  }
  async writeValueWithResponse(buffer:BufferSource){
    const p=ArrayBuffer.isView(buffer)?new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength).slice():new Uint8Array(buffer).slice();
    this.writes.push(p);await this.writer(p);
  }
  async readValue(){
    this.reads++;this.value=await this.reader();
    // Web Bluetooth reads also fire this event; the old fixture omitted it.
    this.dispatchEvent(new Event('characteristicvaluechanged'));return this.value;
  }
  async startNotifications(){await this.starter();return this;}
  change(bytes:Uint8Array){this.value=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);this.dispatchEvent(new Event('characteristicvaluechanged'));}
  notify(bytes:Uint8Array,mtu=247){for(const p of fragments(bytes,mtu))this.change(p);}
}
class Device extends EventTarget implements BluetoothDevice {
  id='test-device';name='VNS_TX_test';tx=new Characteristic();rx=new Characteristic();failures=0;connectCalls=0;seq=0;
  gatt:BluetoothRemoteGATTServer={connected:false,
    connect:async()=>{this.connectCalls++;if(this.failures-->0)throw new Error('temporary radio failure');this.seq=0;this.gatt.connected=true;return this.gatt;},
    disconnect:()=>{const was=this.gatt.connected;this.gatt.connected=false;if(was)this.dispatchEvent(new Event('gattserverdisconnected'));},
    getPrimaryService:async()=>({getCharacteristic:async(uuid:string)=>uuid===NOTIFY_UUID?this.tx:this.rx}),
  };
}
function harness(timeout=100) {
  const d=new Device();let linked=false;const errors:string[]=[];const states:Status[]=[];const samples:Sample[]=[];const infos:EcgInfo[]=[];
  d.tx.starter=async()=>{d.tx.notify(status(d.seq++));};
  d.rx.writer=async p=>{const body=new Uint8Array(8);body[0]=p[4];body[1]=p[5];body[2]=p[2];d.tx.notify(packet(Message.ACK,body,d.seq++));if(p[2]===Message.QUERY)d.tx.notify(status(d.seq++));};
  const client=new TxClient({link:(_,on)=>{linked=on;},status:s=>states.push(s),samples:s=>samples.push(...s),error:e=>{if(e)errors.push(e);},busy:()=>{},loss:()=>{},ecgInfo:info=>infos.push(info)},
    {requestDevice:async()=>d},timeout);
  return {d,client,errors,states,samples,infos,linked:()=>linked};
}
async function until(predicate:()=>boolean,max=1500){const deadline=Date.now()+max;while(!predicate()){if(Date.now()>deadline)throw new Error('test condition timed out');await new Promise(r=>setTimeout(r,5));}}
test('handshake, ACK, disconnect and reconnect own exactly one listener',async()=>{
  const h=harness();try{
    await h.client.connect();assert.ok(h.linked());assert.equal(h.d.tx.listeners.size,1);
    await h.client.monitor(true);assert.equal(h.d.rx.writes.length,1);
    h.client.disconnect();assert.equal(h.d.tx.listeners.size,0);assert.ok(!h.linked());
    await h.client.connect();assert.equal(h.d.tx.listeners.size,1);assert.equal(h.d.rx.writes.length,1);
  }finally{h.client.dispose();}
});
test('legacy receiver cannot complete TX handshake or receive commands',async()=>{
  const h=harness();h.d.tx.starter=async()=>{h.d.tx.change(new Uint8Array([0x80,3,...new Array(18).fill(0)]));};
  try{await h.client.connect();assert.ok(!h.linked());assert.equal(h.d.tx.listeners.size,0);assert.equal(h.d.rx.writes.length,0);assert.ok(h.errors.some(e=>e.includes('Incompatible')));}finally{h.client.dispose();}
});
test('missing ACK closes connection and never replays power-on',async()=>{
  const h=harness(25);h.d.rx.writer=async()=>{};
  try{await h.client.connect();await assert.rejects(h.client.power(true));assert.equal(h.d.rx.writes.length,1);assert.ok(!h.linked());assert.equal(h.d.tx.listeners.size,0);}finally{h.client.dispose();}
});
test('device rejection is reported without reconnecting or retrying command',async()=>{
  const h=harness();h.d.rx.writer=async p=>{const body=new Uint8Array([p[4],p[5],p[2],4,0,0,0,0]);h.d.tx.notify(packet(Message.ERROR,body,h.d.seq++));};
  try{await h.client.connect();await assert.rejects(h.client.power(true),/Power conditions/);assert.ok(h.linked());assert.equal(h.d.rx.writes.length,1);}finally{h.client.dispose();}
});
test('disconnect invalidates both in-flight and queued mutations',async()=>{
  const h=harness(30);let release:()=>void=()=>{};
  h.d.rx.writer=()=>new Promise<void>(resolve=>{release=resolve;});
  try{
    await h.client.connect();const first=h.client.monitor(true);const second=h.client.configure(20,21);
    const f=assert.rejects(first),s=assert.rejects(second);
    await until(()=>h.d.rx.writes.length===1);h.client.disconnect();release();await Promise.all([f,s]);
    assert.equal(h.d.rx.writes.length,1);
  }finally{h.client.dispose();}
});
test('initial connection failure waits for an explicit manual retry',async()=>{
  const h=harness();h.d.failures=1;
  try{await h.client.connect();assert.ok(!h.linked());await new Promise(r=>setTimeout(r,1100));assert.equal(h.d.connectCalls,1);await h.client.connect();assert.ok(h.linked());assert.equal(h.d.connectCalls,2);assert.equal(h.d.tx.listeners.size,1);assert.equal(h.d.rx.writes.length,0);}finally{h.client.dispose();}
});
test('unexpected disconnect stays disconnected until the user reconnects',async()=>{
  const h=harness();try{await h.client.connect();h.d.gatt.disconnect();assert.equal(h.d.tx.listeners.size,0);await new Promise(r=>setTimeout(r,1100));assert.ok(!h.linked());assert.equal(h.d.connectCalls,1);await h.client.connect();assert.ok(h.linked());assert.equal(h.d.tx.listeners.size,1);assert.equal(h.d.rx.writes.length,0);}finally{h.client.dispose();}
});
test('a superseded queued power-on is cancelled before writing',async()=>{
  const h=harness();try{await h.client.connect();const on=h.client.power(true),off=h.client.power(false);await assert.rejects(on,/cancelled/);await off;assert.equal(h.d.rx.writes.length,1);assert.equal(h.d.rx.writes[0][8],0);}finally{h.client.dispose();}
});
test('read-result events cannot break the notification-only handshake',async()=>{
  const h=harness();try{await h.client.connect();assert.ok(h.linked(),h.errors.join('; '));assert.equal(h.d.tx.reads,0);assert.equal(h.d.rx.writes.length,0);}finally{h.client.dispose();}
});
test('macOS read/notify race is avoided without weakening frame checks',async()=>{
  const h=harness();h.d.tx.reader=async()=>new DataView(fragments(status(h.d.seq++))[0].buffer);
  try{await h.client.connect();assert.ok(h.linked(),h.errors.join('; '));assert.equal(h.d.tx.reads,0);}finally{h.client.dispose();}
});
test('MTU23 startup waits for a complete valid status notification',async()=>{
  const h=harness();h.d.tx.starter=async()=>{
    for(const p of fragments(status(h.d.seq++,23),23)){h.d.tx.change(p);assert.ok(!h.linked());}
  };
  try{await h.client.connect();assert.ok(h.linked(),h.errors.join('; '));assert.equal(h.states.at(-1)?.mtu,23);assert.equal(h.d.tx.reads,0);}finally{h.client.dispose();}
});
test('refresh uses GET_STATUS and fresh notifications without GATT Read',async()=>{
  const h=harness();try{await h.client.connect();const before=h.states.length;await h.client.refresh();assert.ok(h.linked());assert.equal(h.states.length,before+1);assert.equal(h.d.tx.reads,0);assert.equal(h.d.rx.writes.length,1);assert.equal(h.d.rx.writes[0][2],Message.QUERY);}finally{h.client.dispose();}
});
test('refresh ACK without status times out and disconnects',async()=>{
  const h=harness(25);h.d.rx.writer=async p=>{h.d.tx.notify(packet(Message.ACK,new Uint8Array([p[4],p[5],p[2],0,0,0,0,0]),h.d.seq++));};
  try{await h.client.connect();await assert.rejects(h.client.refresh(),/status/i);assert.ok(!h.linked());assert.equal(h.d.rx.writes.length,1);}finally{h.client.dispose();}
});
test('missing startup notifications never enable controls or send commands',async()=>{
  const h=harness(25);h.d.tx.starter=async()=>{};
  try{await h.client.connect();assert.ok(!h.linked());assert.equal(h.d.tx.reads,0);assert.equal(h.d.rx.writes.length,0);assert.equal(h.d.tx.listeners.size,0);assert.ok(h.errors.some(e=>/status/i.test(e)));}finally{h.client.dispose();}
});
test('connected idle state sends no background queries',async()=>{
  const h=harness();try{await h.client.connect();await new Promise(r=>setTimeout(r,2200));assert.ok(h.linked());assert.equal(h.d.tx.reads,0);assert.equal(h.d.rx.writes.length,0);}finally{h.client.dispose();}
});
test('sensor faults remain visible without blocking the BLE connection',async()=>{
  const h=harness();h.d.tx.starter=async()=>{const p=status(h.d.seq++);new DataView(p.buffer).setUint32(28,7,true);h.d.tx.notify(p);};
  try{await h.client.connect();assert.ok(h.linked());assert.equal(h.states.at(-1)?.faults,7);assert.equal(h.d.rx.writes.length,0);}finally{h.client.dispose();}
});
test('repeated Connect clicks share one in-flight connection attempt',async()=>{
  const h=harness();try{await Promise.all([h.client.connect(),h.client.connect()]);assert.ok(h.linked());assert.equal(h.d.connectCalls,1);assert.equal(h.d.tx.listeners.size,1);}finally{h.client.dispose();}
});
test('PPG failure status still delivers ECG and temperature frames through one notification listener',async()=>{
  const h=harness();try{
    await h.client.connect();await h.client.monitor(true);
    const p=status(h.d.seq++),v=new DataView(p.buffer);v.setUint32(20,255,true);v.setUint32(24,5,true);v.setUint32(28,2,true);p[52]=1;p[62]=5;
    h.d.tx.notify(p,23);
    const ecg=new Uint8Array([0,0,0,0,0,1,1,4,0xc0,0xff,0xff,10]);
    const temp=new Uint8Array(12),tv=new DataView(temp.buffer);tv.setInt32(0,23576,true);tv.setInt32(4,23432,true);
    h.d.tx.notify(packet(Message.ECG,ecg,h.d.seq++),23);
    h.d.tx.notify(packet(Message.TEMP,temp,h.d.seq++),23);
    assert.ok(h.linked());assert.equal(h.d.tx.listeners.size,1);assert.equal(h.states.at(-1)?.activeSensors,5);
    assert.deepEqual(h.samples.map(s=>s.type),['ecg','temperature']);
    assert.equal(h.samples[0].a,-1);assert.equal(h.samples[0].valid,false);assert.equal(h.samples[1].a,23.576);
  }finally{h.client.dispose();}
});

function ecgInfoPacket(id:number,seq:number){
 const a=new Uint8Array(104),v=new DataView(a.buffer);v.setUint32(0,123,true);v.setUint16(4,id,true);
 a[6]=1;a[7]=15;v.setUint32(8,0x081117,true);v.setUint32(20,0x425000,true);
 v.setUint16(28,256,true);v.setUint16(30,80,true);v.setUint16(34,80,true);v.setBigUint64(92,1000000n,true);
 return packet(Message.ECG_INFO,a,seq);
}
test('ECG readback uses notifications and waits for its own actual report',async()=>{
 const h=harness();try{
  await h.client.connect();h.d.rx.writer=async p=>{
   h.d.tx.notify(packet(Message.ACK,new Uint8Array([p[4],p[5],p[2],0,0,0,0,0]),h.d.seq++));
   h.d.tx.notify(ecgInfoPacket(p[4]|p[5]<<8,h.d.seq++),23);
  };
  await h.client.readEcg();assert.equal(h.infos.length,1);assert.equal(h.infos[0].gain,80);
  assert.equal(h.d.tx.reads,0);assert.equal(h.d.tx.listeners.size,1);
 }finally{h.client.dispose();}
});
test('ECG ACK without readback cannot silently reuse an old register report',async()=>{
 const h=harness(25);try{await h.client.connect();
  await assert.rejects(h.client.readEcg(),/fresh ECG/);assert.ok(!h.linked());
 }finally{h.client.dispose();}
});
test('request ID wrap skips unsolicited ECG report ID and awaits the matching readback',async()=>{
 const h=harness(100);try{await h.client.connect();Reflect.set(h.client,'requestId',0xffff);
  let finish:()=>void=()=>{};
  h.d.rx.writer=async p=>{
   assert.equal(p[4]|p[5]<<8,0);
   h.d.tx.notify(packet(Message.ACK,new Uint8Array([p[4],p[5],p[2],0,0,0,0,0]),h.d.seq++));
   h.d.tx.notify(ecgInfoPacket(0xffff,h.d.seq++));
   finish=()=>h.d.tx.notify(ecgInfoPacket(0,h.d.seq++));
  };
  let resolved=false;const read=h.client.readEcg().then(()=>{resolved=true;});
  await until(()=>h.infos.length===1);assert.equal(resolved,false);
  finish();await read;assert.equal(resolved,true);assert.equal(h.infos.length,2);
 }finally{h.client.dispose();}
});
