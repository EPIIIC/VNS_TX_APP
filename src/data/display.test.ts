import test from 'node:test';
import assert from 'node:assert/strict';
import { channelState, drawableSample, faultMessage, measurementFresh } from './display';
import { decodeFrame, decodeStatus, Message, type Sample } from '../ble/protocol';
import { csv } from './recording';

function partialStatus() {
  const p=new Uint8Array(64),v=new DataView(p.buffer);p.set([0xa7,1,Message.STATUS,0]);
  v.setUint16(6,48,true);v.setBigUint64(8,2_000_000n,true);
  v.setUint32(20,255,true);v.setUint32(24,5,true);v.setUint32(28,2,true);
  p[52]=1;p[62]=5;v.setUint16(56,256,true);v.setUint16(58,100,true);v.setUint16(60,247,true);
  return decodeStatus(decodeFrame(v));
}
test('partial status keeps ECG/temperature active and PPG visibly unavailable',()=>{
  const s=partialStatus();assert.equal(s.activeSensors,5);assert.equal(s.faults,2);
  assert.equal(channelState(s,1),'Running');assert.equal(channelState(s,2),'Unavailable');assert.equal(channelState(s,4),'Running');
  assert.match(faultMessage(s),/Available sensors continue recording/);assert.match(faultMessage(s),/Power is disabled/);
});
test('PPG fault does not suppress fresh temperature; device time invalidates stalled values',()=>{
  const s=partialStatus(),temp:Sample={type:'temperature',timeUs:1_500_000,index:0,a:23.576,b:23.432,flags:2,valid:true};
  assert.equal(measurementFresh(temp,s,4),true);
  assert.equal(measurementFresh(temp,{...s,timeUs:7_000_000},4),false);
  assert.equal(measurementFresh(temp,{...s,faults:6},4),false);
  assert.equal(measurementFresh(temp,{...s,monitoring:false,activeSensors:0},4),false);
});
test('invalid raw ECG remains visible while filtered-only CSV omits its raw value',()=>{
  const raw:Sample={type:'ecg',timeUs:1_500_000,index:0,a:-123,b:0xffffc0,tag:0,flags:10,valid:false};
  assert.ok(drawableSample(raw,'ecg'));assert.equal(raw.valid,false);
  const exported=csv([{...raw,bootId:1,connection:1}]);assert.match(exported,/1500000,0,/);
  assert.doesNotMatch(exported,/-123/);
  assert.doesNotMatch(exported,/flags|valid|error|fault/);
  assert.equal(drawableSample({...raw,type:'ppg'},'ppg'),false);
  assert.equal(measurementFresh({...raw,type:'rr'},partialStatus(),1),false);
});
test('all-failed monitoring stays explicit and legacy firmware gets an update message',()=>{
  const s=partialStatus();assert.match(faultMessage({...s,activeSensors:0,faults:7}),/Waiting for sensor recovery/);
  assert.match(faultMessage({...s,capabilities:127,monitoring:false}),/Update TX firmware/);
});
