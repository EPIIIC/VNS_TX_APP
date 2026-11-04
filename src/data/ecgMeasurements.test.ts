import test from 'node:test';
import assert from 'node:assert/strict';
import {countsToMv,decodeSamples,decodeEcgInfo,Message,type Frame,type Sample} from '../ble/protocol';
import {EcgDisplay,DEFAULT_DISPLAY} from './ecgDisplay';
import {EcgAxis,ecgMetrics,registerLog} from './ecgMeasurements';
import {csv} from './recording';
// Exercise the Raw/Auto feature independently of the user's startup profile.
const RAW_AUTO={...DEFAULT_DISPLAY,mode:'raw' as const,notch:false,range:null};
test('ADI signed18 conversion uses actual gain and 1 V reference, never int16',()=>{
  for(const gain of [20,40,80,160]) {
    assert.equal(countsToMv(-131072,gain),-1000/gain);
    assert.equal(countsToMv(65536,gain),500/gain);
    assert.equal(countsToMv(5243,gain),5243*1000/(131072*gain));
  }
  assert.equal(countsToMv(100),null);assert.equal(countsToMv(100,0),null);
});
function metaFrame(source=0,gain=80):Frame {
  const a=new Uint8Array(24),p=new DataView(a.buffer);p.setUint32(0,123,true);p.setUint16(4,256,true);
  a[6]=3;a[7]=4;p.setUint16(8,gain,true);a[10]=source;a[11]=1;
  [-131072,131071,-32769].forEach((n,i)=>{const raw=((n&0x3ffff)<<6)|(i===2?2<<3:0);a[12+i*4]=raw;a[13+i*4]=raw>>8;a[14+i*4]=raw>>16;a[15+i*4]=source?16:0;});
  return {type:Message.ECG_META,seq:1,timeUs:1000000,flags:0,payload:p};
}
test('gain-tagged C-compatible bytes preserve 18-bit extremes, source and rational timestamps',()=>{
  const s=decodeSamples(metaFrame());assert.deepEqual(s.map(x=>x.a),[-131072,131071,-32769]);
  assert.equal(s[0].gain,80);assert.equal(s[0].inputMv,-12.5);assert.equal(s[1].timeUs,1003907);
  const cal=decodeSamples(metaFrame(1));assert.ok(cal.every(s=>s.source===1&&!s.valid));
  assert.match(csv(cal.map(s=>({...s,bootId:1,connection:1}))),/internal_cal_0.5mVpp/);
  assert.throws(()=>decodeSamples(metaFrame(255)));assert.throws(()=>decodeSamples(metaFrame(0,0)));
});
test('Raw and calibration modes are exact sensor values, independent of GUI filters',()=>{
  for(const options of [RAW_AUTO,DEFAULT_DISPLAY]) {
    const dsp=new EcgDisplay(options);
    for(let i=0;i<1024;i++) {
      const s:Sample={type:'ecg',timeUs:i*3906.25,index:i,a:i-500,b:0,flags:16,tag:0,valid:false,gain:80,source:1};
      assert.equal(dsp.push(s).a,s.a);
    }
  }
  const raw=new EcgDisplay(RAW_AUTO);
  for(let i=0;i<1024;i++) {
    const s:Sample={type:'ecg',timeUs:i*3906.25,index:i,a:i-500,b:0,flags:2,tag:0,valid:true,gain:160,source:0};
    assert.equal(raw.push(s).a,s.a);
  }
});
test('mV Auto Scale and fixed range use batch gain; legacy data stays Counts',()=>{
  const raw:Sample={type:'ecg',timeUs:1e6,index:1,a:1049,b:0,flags:2,tag:0,valid:true,gain:80,source:0,rate:256};
  const p=new EcgDisplay(RAW_AUTO).push(raw),axis=new EcgAxis();
  const auto=axis.range([p],RAW_AUTO);assert.equal(auto.unit,'mV');assert.ok(auto.half>=.1&&auto.half<=.2);
  assert.equal(axis.range([p],{...DEFAULT_DISPLAY,range:.5}).half,.5);
  assert.equal(axis.range([{...p,sample:{...raw,gain:undefined}}],DEFAULT_DISPLAY).unit,'Counts');
  const metrics=ecgMetrics([raw,{...raw,a:-1049}]);assert.ok(metrics.vppMv!>.2);
});
test('actual readback log masks failed registers and does not substitute expected values',()=>{
  const p=new DataView(new ArrayBuffer(104));p.setUint8(6,1);p.setUint8(7,9);
  p.setUint32(8,0x081117,true);p.setUint32(20,0x425000,true);p.setUint16(28,256,true);p.setUint16(30,80,true);
  p.setUint8(32,0);p.setUint16(34,80,true);p.setBigUint64(92,123456n,true);
  const info=decodeEcgInfo({type:Message.ECG_INFO,flags:0,seq:0,timeUs:200000,payload:p});
  const log=registerLog(info);assert.match(log,/CNFG_GEN\(0x10\) = 0x081117/);
  assert.match(log,/CNFG_CAL\(0x12\) = READ FAILED/);assert.match(log,/read_device_us=123456/);
});
test('numerical calibration vectors recover nominal mVpp without labelling them human ECG',()=>{
  for(const [source,peak,expected] of [[1,2621,.5],[2,5243,1]]) {
    const samples:Sample[]=Array.from({length:512},(_,i)=>({type:'ecg',timeUs:i*3906.25,index:i,
      a:i%16<8?peak:-peak,b:0,tag:0,flags:16,valid:false,gain:80,source,rate:256}));
    const result=ecgMetrics(samples);assert.ok(Math.abs(result.calibrationPpMv!-expected)<.0002);
    assert.ok(samples.every(s=>!s.valid));
  }
});
