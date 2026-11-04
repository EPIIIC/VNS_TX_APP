import test from 'node:test';
import assert from 'node:assert/strict';
import type {Sample} from '../ble/protocol';
import {Spo2Analyzer,ratioToSpo2,type Spo2Reading} from './spo2';

// Numerical optical fixtures only. These do NOT validate oxygen accuracy.
const ppg=(i:number,ratio=.43,hz=1.2):Sample=>{
  const phase=2*Math.PI*hz*i/100,pulse=Math.sin(phase)+.15*Math.sin(2*phase);
  return {type:'ppg',index:i,timeUs:i*10000,a:40000+1000*ratio*pulse,b:80000+2000*pulse,
    flags:2,valid:true,ledRed:31,ledIr:31};
};
function run(change:(s:Sample)=>Sample=s=>s) {
  const analyzer=new Spo2Analyzer(),out:Spo2Reading[]=[];
  for(let i=0;i<1800;i++){const r=analyzer.push(change(ppg(i)));if(r)out.push(r);}
  return {analyzer,out};
}
test('paired optical AC/DC ratios use the documented illustrative equation without clamping',()=>{
  assert.equal(ratioToSpo2(.43),104-17*.43);
  for(const r of [0,-1,.1,3,NaN,Infinity])assert.equal(ratioToSpo2(r),null);
  const {out}=run();assert.ok(out.length>=8);
  // Beat-valley baseline differs slightly from the fixture's whole-cycle mean DC.
  assert.ok(out.every(r=>r.estimatePct!==null&&Math.abs(r.estimatePct-(104-17*.43))<.15));
  assert.equal(out[0].timeUs,9990000);
});
test('SpO2 excludes missing/off LED metadata, rail clipping, flatline, low perfusion and mismatched channels',()=>{
  for(const change of [
    (s:Sample)=>({...s,ledRed:undefined}), (s:Sample)=>({...s,ledIr:0}),
    (s:Sample)=>({...s,valid:false}), (s:Sample)=>({...s,a:262143}),
    (s:Sample)=>({...s,a:40000,b:80000}),
    (s:Sample)=>({...s,a:40000+(s.a-40000)*.001,b:80000+(s.b-80000)*.001}),
    (s:Sample)=>({...s,a:40000+430*Math.sin(2*Math.PI*1.8*s.index/100)}),
    (s:Sample)=>({...s,a:40000+(s.a-40000)*10}),
  ])assert.ok(run(change).out.every(r=>r.estimatePct===null));
});
test('gap, clock discontinuity, current change and invalid samples discard the complete optical window',()=>{
  for(const change of [{index:2000},{timeUs:20e6},{ledRed:32,ledIr:32},{valid:false}]) {
    const {analyzer}=run();assert.notEqual(analyzer.reading(18e6).estimatePct,null);
    analyzer.push({...ppg(1800),...change});assert.equal(analyzer.reading(20e6).estimatePct,null);
  }
  assert.equal(run().analyzer.reading(30e6).estimatePct,null);
});
test('large contact drift or inter-channel phase error produces no oxygen estimate',()=>{
  const drift=run(s=>({...s,a:s.a+s.index*8,b:s.b+s.index*16}));
  assert.ok(drift.out.every(r=>r.estimatePct===null));
  const phase=run(s=>({...s,a:40000+430*Math.cos(2*Math.PI*1.2*s.index/100)}));
  assert.ok(phase.out.every(r=>r.estimatePct===null));
});
