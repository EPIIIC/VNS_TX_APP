import test from 'node:test';
import assert from 'node:assert/strict';
import {command,decodeFrame,decodeSamples,decodeStatus,Message,Reassembler} from './protocol';
export function frame(type:Message,payload:Uint8Array,seq=0,time=1_000_000,flags=0) {
  const a=new Uint8Array(16+payload.length),v=new DataView(a.buffer);
  a.set([0xa7,1,type,flags]);v.setUint16(4,seq,true);v.setUint16(6,payload.length,true);v.setBigUint64(8,BigInt(time),true);a.set(payload,16);return a;
}
export function statusFrame(seq=0) {
  const p=new Uint8Array(48),v=new DataView(p.buffer);
  v.setUint32(0,123,true);v.setUint32(4,63,true);v.setUint32(8,7,true);
  v.setUint16(40,256,true);v.setUint16(42,100,true);v.setUint16(44,247,true);p[38]=p[39]=31;
  return frame(Message.STATUS,p,seq);
}
export function fragments(bytes:Uint8Array,mtu=23) {
  const seq=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint16(4,true),result:DataView[]=[];
  for(let offset=0;offset<bytes.length;offset+=mtu-9) {
    const data=bytes.slice(offset,offset+mtu-9),p=new Uint8Array(6+data.length),v=new DataView(p.buffer);
    p.set([0xd7,1]);v.setUint16(2,seq,true);v.setUint16(4,offset,true);p.set(data,6);result.push(v);
  }return result;
}
test('C-compatible golden command and strict validation',()=>{
  assert.deepEqual([...command(Message.MONITOR,42,[1])],[0xc7,1,0x10,1,42,0,0,0,1]);
  assert.throws(()=>command(Message.POWER,1,[2]));assert.throws(()=>command(Message.CONFIG,1,[1,-1,128]));
});
test('maximum frame round trip at every MTU 23..247',()=>{
  const data=frame(Message.ECG,new Uint8Array(176).map((_,i)=>i),0x1234,123456789,2);
  for(let mtu=23;mtu<=247;mtu++){
    const r=new Reassembler();let complete=null;
    for(const p of fragments(data,mtu))complete=r.push(p)??complete;
    assert.equal(complete?.seq,0x1234);assert.equal(complete?.timeUs,123456789);assert.equal(complete?.payload.byteLength,176);
    assert.equal(r.dropped,0);
  }
});
test('out of order, missing and duplicate fragments never create partial data',()=>{
  const r=new Reassembler(),pieces=fragments(statusFrame(10));
  assert.equal(r.push(pieces[0]),null);assert.equal(r.push(pieces[2]),null);
  assert.equal(r.push(pieces[1]),null);
  let complete=null;for(const p of fragments(statusFrame(11)))complete=r.push(p)??complete;
  assert.equal(complete?.seq,11);
  for(const p of fragments(statusFrame(11)))assert.equal(r.push(p),null);
  assert.ok(r.dropped>0);
});
test('notification sequence rollover and reconnect reset',()=>{
  const r=new Reassembler();
  for(const seq of [65535,0,1]){let got=null;for(const p of fragments(statusFrame(seq),247))got=r.push(p);assert.equal(got?.seq,seq);}
  assert.equal(r.dropped,0);r.reset();assert.ok(r.push(fragments(statusFrame(0),247)[0]));
});
test('legacy version and corrupted declared length rejected',()=>{
  assert.throws(()=>decodeFrame(new DataView(new Uint8Array([0x80,3,...new Array(18).fill(0)]).buffer)));
  const bytes=statusFrame();bytes[6]=47;assert.throws(()=>decodeFrame(new DataView(bytes.buffer)));
  const good=decodeFrame(new DataView(statusFrame().buffer));assert.equal(decodeStatus(good).bootId,123);
});
test('ECG signed18, fast tag and fractional timestamp phase match C',()=>{
  const words=[0x7fffc0,0x800008,0xffffd0],p=new Uint8Array(8+12),v=new DataView(p.buffer);
  v.setUint32(0,1,true);v.setUint16(4,256,true);p[6]=3;p[7]=4;
  words.forEach((w,i)=>p.set([w&255,(w>>8)&255,w>>16,2],8+i*4));
  const samples=decodeSamples(decodeFrame(new DataView(frame(Message.ECG,p,1,3906).buffer)));
  assert.deepEqual(samples.map(s=>s.a),[131071,-131072,-1]);
  assert.deepEqual(samples.map(s=>s.valid),[true,false,true]);
  assert.deepEqual(samples.map(s=>s.timeUs),[3906,7812,11718]);
});
test('PPG channel order, limits and no medical result fabrication',()=>{
  const p=new Uint8Array([0,0,0,0,100,0,1,7,1,2,3,4,5,2,2]);
  const result=decodeSamples(decodeFrame(new DataView(frame(Message.PPG,p).buffer)))[0];
  assert.equal(result.a,0x030201);assert.equal(result.b,0x020504);assert.equal(result.type,'ppg');
  p[10]=4;assert.throws(()=>decodeSamples(decodeFrame(new DataView(frame(Message.PPG,p).buffer))));
});
test('R-R is hidden unless explicit verified flag and status are valid',()=>{
  const p=new Uint8Array(12);new DataView(p.buffer).setUint32(0,128,true);
  const unverified=decodeSamples(decodeFrame(new DataView(frame(Message.RR,p).buffer)))[0];
  assert.equal(unverified.a,1000);assert.equal(unverified.valid,false);
});
