import test from 'node:test';
import assert from 'node:assert/strict';
import { EcgDisplay, StableEcgScale, ecgView, type WavePoint } from './ecgDisplay';
import type { Sample } from '../ble/protocol';
import { Recording, csv } from './recording';

const sample=(index:number,a=123):Sample=>({type:'ecg',timeUs:1e6+Math.floor(index*1e6/256),index,a,
  b:((a&0x3ffff)<<6)|7,flags:2,tag:0,valid:true});
const rms=(values:number[])=>Math.sqrt(values.reduce((a,b)=>a+b*b,0)/values.length);
function tone(frequency:number,amplitude=1000) {
  const filter=new EcgDisplay(),out:number[]=[];
  for(let i=0;i<8192;i++) {
    const p=filter.push(sample(i,amplitude*Math.sin(2*Math.PI*frequency*i/256)));
    if(i>=4096&&p.a!==null)out.push(p.a);
  }
  return rms(out)/(amplitude/Math.sqrt(2));
}
test('50 Hz display notch suppresses mains while retaining ECG-band signals',()=>{
  assert.ok(tone(50)<.001);
  assert.ok(tone(49.9)<.2);
  assert.ok(tone(10)>.97&&tone(10)<1.02);
  assert.ok(tone(1)>.99&&tone(1)<1.01);
  assert.ok(tone(.25)>.99); // Do not add a second GUI high-pass over the chip HP.
});
test('low-pass rejects high-frequency noise and wider notch handles near-50 Hz interference',()=>{
  assert.ok(tone(20)>.95&&tone(20)<1.01);
  assert.ok(tone(30)>.85&&tone(30)<.92);
  assert.ok(tone(40)>.68&&tone(40)<.72);
  assert.ok(tone(49.9)<.1&&tone(50.1)<.1);
  assert.ok(tone(60)>.3&&tone(60)<.35&&tone(80)<.14);
});
test('test-only pulse retains one main peak without large ringing or excessive display delay',()=>{
  // Synthetic numerical fixture only; never shown as measured ECG in the app.
  const filter=new EcgDisplay(),center=1024,out:number[]=[];
  for(let i=0;i<2048;i++) {
    const value=2000*Math.exp(-.5*((i-center)/3)**2)
      -300*Math.exp(-.5*((i-center+6)/2)**2)-500*Math.exp(-.5*((i-center-7)/3)**2);
    const p=filter.push(sample(i,value));out.push(p.mode==='filtered'?p.a!:0);
  }
  const peak=Math.max(...out),where=out.indexOf(peak);
  assert.ok(peak>1300&&peak<2300);
  assert.ok(where>=center&&where-center<=10); // <=39.1 ms numerical pulse latency.
  assert.equal(out.filter((v,i)=>i>0&&i<out.length-1&&v>600&&v>out[i-1]&&v>=out[i+1]).length,1);
  assert.ok(Math.max(...out.slice(center+64).map(Math.abs))<100);
});
test('one-second warmup exposes raw input; initial DC does not create a filtered pulse',()=>{
  const filter=new EcgDisplay();
  for(let i=0;i<256;i++) {
    const p=filter.push(sample(i,20000));assert.equal(p.a,20000);assert.equal(p.mode,'settling');
  }
  const p=filter.push(sample(256,20000));
  assert.equal(p.mode,'filtered');assert.ok(Math.abs(p.a!-20000)<1e-6);assert.equal(p.gap,true);
});
test('raw samples, FIFO words, timestamps and CSV are unchanged by display processing',()=>{
  const filter=new EcgDisplay(),r=new Recording();
  const raw=Array.from({length:4096},(_,i)=>Object.freeze(sample(i,Math.round(1000*Math.sin(i)))));
  r.add(raw,123,2);const before=csv(r.rows);
  const points=raw.map(s=>filter.push(s));
  assert.equal(csv(r.rows),before);assert.equal(points.at(-1)!.sample,raw.at(-1));
  assert.notEqual(points.at(-1)!.a,raw.at(-1)!.a);
  assert.equal(points.at(-1)!.sample.timeUs,raw.at(-1)!.timeUs);
});
test('clipped and fast-recovery samples remain raw and reset filter state',()=>{
  for(const bad of [sample(300,131071),
    {...sample(300),tag:1,valid:false}]) {
    const filter=new EcgDisplay();for(let i=0;i<300;i++)filter.push(sample(i));
    const p=filter.push(bad);assert.equal(p.mode,'raw');assert.equal(p.a,bad.a);
    for(let i=301;i<=556;i++)assert.equal(filter.push(sample(i)).mode,'settling');
    assert.equal(filter.push(sample(557)).mode,'filtered');
  }
});
test('gaps, time discontinuities, Clear and session restarts cannot bridge filter history',()=>{
  for(const next of [{...sample(300),flags:3},sample(301),{...sample(300),timeUs:9e6},sample(0)]) {
    const filter=new EcgDisplay();for(let i=0;i<300;i++)filter.push(sample(i,500));
    const p=filter.push(next);assert.equal(p.mode,'settling');assert.equal(p.gap,true);
  }
  const filter=new EcgDisplay();for(let i=0;i<300;i++)filter.push(sample(i));filter.reset();
  assert.equal(filter.push(sample(0)).mode,'settling');
});
test('filter output is independent of notification batch size',()=>{
  const raw=Array.from({length:1024},(_,i)=>sample(i,Math.sin(i)*1000));
  const one=new EcgDisplay(),batched=new EcgDisplay();
  const expected=raw.map(s=>one.push(s)),actual:WavePoint[]=[];
  for(let i=0;i<raw.length;i+=12)for(const s of raw.slice(i,i+12))actual.push(batched.push(s));
  assert.deepEqual(actual,expected);
});
test('ECG scale stays centered; invalid data and isolated outliers do not control it',()=>{
  const scale=new StableEcgScale();
  const points=(value:number):WavePoint[]=>Array.from({length:256},(_,i)=>({sample:sample(i),a:value,b:null,gap:false,mode:'filtered'}));
  assert.equal(scale.update(points(200)),4096);
  assert.equal(scale.update([...points(200),{...points(200)[0],a:131071}]),4096);
  assert.equal(scale.update(points(131071).map(p=>({...p,mode:'raw'}))),4096);
  assert.equal(scale.update(points(6000)),8192);
  assert.equal(scale.update(points(200)),8192);
  assert.equal(scale.update([]),8192);
  assert.equal(new StableEcgScale().update(points(200)),4096);
});
test('raw input during invalid or warmup states cannot disappear outside the filtered axis',()=>{
  for(const s of [sample(0,100000),{...sample(0,-131072),valid:false,flags:10}]) {
    const raw=Object.freeze(s),point=new EcgDisplay().push(raw),scale=new StableEcgScale();
    const view=ecgView([point],scale);
    assert.equal(view.mode,'raw');assert.equal(view.half,131072);
    assert.equal(view.points[0].a,raw.a);assert.equal(view.points[0].sample,raw);
    assert.ok(Math.abs(view.points[0].a!)<=view.half);
    assert.equal(view.points[0].sample.valid,raw.valid);
  }
});
test('filtered and raw axes never mix within one view and raw points retain CSV quality',()=>{
  const filter=new EcgDisplay(),points=Array.from({length:600},(_,i)=>filter.push(sample(i,1000*Math.sin(i))));
  const view=ecgView(points,new StableEcgScale());assert.equal(view.mode,'filtered');
  assert.equal(view.points[0].a,null);assert.equal(view.points.at(-1)!.mode,'filtered');
  const bad=filter.push({...sample(600,131071),valid:false,flags:10});
  const fallback=ecgView([...points,bad],new StableEcgScale());
  assert.equal(fallback.mode,'raw');assert.ok(fallback.points.every(p=>p.mode==='raw'));
  assert.equal(fallback.points.at(-1)!.sample.valid,false);
});
test('persistent quality warnings retain a filtered dashed-diagnostic input without changing validity',()=>{
  const filter=new EcgDisplay(),points:WavePoint[]=[],recording=new Recording();
  for(let i=0;i<4096;i++) {
    const s=Object.freeze({...sample(i,500*Math.sin(2*Math.PI*4*i/256)+3000*Math.sin(2*Math.PI*50*i/256)),valid:false,flags:10});
    recording.add([s],1,1);points.push(filter.push(s));
  }
  assert.equal(points.at(-1)!.mode,'filtered');
  assert.equal(points.at(-1)!.sample.valid,false);
  const view=ecgView(points.slice(-2048),new StableEcgScale());
  assert.equal(view.mode,'filtered');assert.ok(view.half<131072);
  assert.ok(rms(view.points.map(p=>p.a!))<500);
  assert.ok(recording.rows.every(s=>!s.valid&&s.flags===10));
  assert.ok(view.points.every(p=>!p.sample.valid));
});
test('unverified filtered diagnostics cannot expand the verified ECG axis',()=>{
  const scale=new StableEcgScale();
  const points:WavePoint[]=Array.from({length:512},(_,i)=>({sample:{...sample(i),valid:false,flags:10},
    a:30000,b:null,gap:false,mode:'filtered'}));
  assert.equal(ecgView(points,scale).half,65536);
  assert.equal(scale.update(points),4096);
});
test('artifact-expanded axis recovers slowly using device time, never redraw frequency',()=>{
  const scale=new StableEcgScale();
  const points=(value:number,time:number):WavePoint[]=>Array.from({length:512},(_,i)=>({
    sample:{...sample(i),timeUs:time-(511-i)*3906.25},a:value,b:null,gap:false,mode:'filtered'}));
  assert.equal(scale.update(points(50000,2e6)),65536);
  assert.equal(scale.update(points(100,4e6)),65536);
  for(let i=0;i<100;i++)assert.equal(scale.update(points(100,4e6)),65536);
  assert.equal(scale.update(points(100,8e6)),65536);
  assert.equal(scale.update(points(100,9e6)),32768);
  assert.equal(scale.update(points(100,10e6)),32768);
  assert.equal(scale.update(points(100,11e6)),16384);
  scale.pause();assert.equal(scale.update(points(100,20e6)),16384);
});
