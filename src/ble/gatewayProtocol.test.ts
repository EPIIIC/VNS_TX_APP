import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeGateway,stimulationCommand,validStimParameters,gatewayLinkError,StimOp,GATEWAY_VERSION} from './gatewayProtocol';
const params={currentUa:1000,frequencyMhz:15000,widthUs:250,durationMs:1000};
// Encoding/guard fixtures only. NOT approved output ranges or hardware results.
test('stimulation command fits MTU23 and preserves integer units, nonce and transaction',()=>{
  const p=stimulationCommand(StimOp.Configure,0x1234,0xabcdef01,params),v=new DataView(p.buffer);
  assert.equal(p.length,20);assert.equal(p[0],GATEWAY_VERSION);assert.equal(p[1],2);
  assert.equal(v.getUint16(2,true),0x1234);assert.equal(v.getUint32(4,true),0xabcdef01);
  assert.equal(v.getUint16(8,true),1000);assert.equal(v.getUint32(10,true),15000);
  assert.equal(v.getUint16(14,true),250);assert.equal(v.getUint32(16,true),1000);
});
test('encoder rejects signed, fractional and oversized fields instead of truncating',()=>{
  for(const change of [{currentUa:-1},{currentUa:65536},{widthUs:65536},{widthUs:1.2},{frequencyMhz:2**32},{durationMs:NaN}])
    assert.throws(()=>stimulationCommand(StimOp.Configure,1,1,{...params,...change}));
  assert.throws(()=>stimulationCommand(StimOp.Configure,65535,1,params));
  assert.throws(()=>stimulationCommand(StimOp.Start,1,1,params));
  const stop=stimulationCommand(StimOp.Stop,2,0);assert.ok(stop.slice(8).every(n=>n===0));
});
test('absent/locked limits and overlapping pulse windows cannot authorize START parameters',()=>{
  assert.equal(validStimParameters(params,null),false);
  const limits={currentUa:1000,minFrequencyMhz:15000,maxFrequencyMhz:15000,minWidthUs:250,maxWidthUs:250,durationMs:1000};
  assert.ok(validStimParameters(params,limits));
  for(const change of [{currentUa:1001},{widthUs:0},{durationMs:0},{frequencyMhz:0}])assert.equal(validStimParameters({...params,...change},limits),false);
  assert.equal(validStimParameters(params,{...limits,currentUa:0}),false);
});
test('RX state bits do not overlap command ID; power and physical-state values decode independently',()=>{
  const b=new Uint8Array(20),v=new DataView(b.buffer);b.set([GATEWAY_VERSION,0x80]);v.setUint16(2,400,true);b[4]=3;
  v.setUint16(6,(2<<8)|125,true);v.setUint32(8,123,true);v.setUint16(12,3300,true);v.setUint16(14,4800,true);v.setUint32(16,500,true);
  const p=decodeGateway(v);assert.equal(p.type,'rx');if(p.type!=='rx')return;
  assert.equal(p.value.id,400);assert.equal(p.value.state,2);assert.equal(p.value.vddMv,3300);assert.equal(p.value.nonce,123);
  assert.equal(p.value.flags&2,0);assert.equal(p.value.flags&64,64); // Allowed link is not authenticated security.
  assert.throws(()=>decodeGateway(new DataView(new ArrayBuffer(19))));
  b[0]=1;assert.throws(()=>decodeGateway(v),/same direct-link firmware/);
});
test('gateway reports the failed link stage and retains signed errno or HCI/ATT codes',()=>{
  // Protocol fixtures only; these are not measurements from the user's RX.
  const b=new Uint8Array(20),v=new DataView(b.buffer);b.set([GATEWAY_VERSION,0x82,7,1]);
  v.setUint16(4,1,true);v.setInt16(6,-2,true);b[16]=3;v.setUint16(18,4000,true);
  const p=decodeGateway(v);assert.equal(p.type,'gateway');if(p.type!=='gateway')return;
  assert.equal(p.value.error,-2);assert.equal(p.value.failureStage,3);assert.equal(p.value.retryMs,4000);
  assert.equal(gatewayLinkError(p.value),'RX service discovery failed (code -2)');
  assert.equal(gatewayLinkError({...p.value,failureStage:9,error:8}),'RX link disconnected (HCI 0x08)');
  assert.equal(gatewayLinkError({...p.value,failureStage:6,error:5}),'RX notification subscription failed (ATT 0x05)');
  assert.equal(gatewayLinkError({...p.value,error:0}),null);
  assert.equal(gatewayLinkError({...p.value,flags:0}),null);
  assert.equal(gatewayLinkError({...p.value,failureStage:0}),'RX link error (code -2)'); // Earlier v2 firmware.
});
