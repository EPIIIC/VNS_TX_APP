export const SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
export const NOTIFY_UUID = '12345678-1234-5678-1234-56789abcdef1';
export const WRITE_UUID = '12345678-1234-5678-1234-56789abcdef2';
export const VERSION = 1;
export const HEADER = 16;
export const MAX_FRAME = 192;
export enum Message { ECG=1, PPG=2, TEMP=3, RR=4, STATUS=5, ECG_META=7, ECG_INFO=8, MONITOR=0x10, POWER=0x11, CONFIG=0x12, QUERY=0x13, ECG_QUERY=0x15, ACK=0x20, ERROR=0x21 }
export type Frame = { type: Message; flags: number; seq: number; timeUs: number; payload: DataView };
export type Status = {
  bootId: number; capabilities: number; available: number; faults: number;
  droppedSamples: number; droppedFrames: number; ecgOverflows: number; ppgOverflows: number;
  ecgStatus: number; monitoring: boolean; power: number; red: number; ir: number;
  ecgRate: number; ppgRate: number; mtu: number; timeUs: number; activeSensors: number;
};
export type Sample = { type: 'ecg'|'ppg'|'temperature'|'rr'; timeUs: number; index: number; a: number; b: number; flags: number; tag?: number; valid: boolean; gain?:number;source?:number;rate?:number;inputMv?:number|null;
  /** WebApp-only acquisition metadata from confirmed device status; not wire bytes. */
  ledRed?:number;ledIr?:number };
export const validGain=(gain:number)=>[20,40,80,160].includes(gain);
/** ADI conversion FAQ: VREF=1 V; input V = signedCode/(2^17 * gain). */
export function countsToMv(count:number,gain?:number):number|null {
  return gain!==undefined&&validGain(gain)&&Number.isFinite(count)?count*1000/(131072*gain):null;
}
export type EcgInfo={bootId:number;requestId:number;timeUs:number;readTimeUs:number;validMask:number;registers:number[];
  status:number;rate:number;gain:number;source:number;selectedSource:number;selectedGain:number;
  error:number;min:number;max:number;samples:number;tags:number[];clipped:number;revision:number;runRevision:number};
export function decodeEcgInfo(frame:Frame):EcgInfo {
  const p=frame.payload;
  if(frame.type!==Message.ECG_INFO||p.byteLength!==104||p.getUint8(6)!==1||p.getUint8(7)>15||
    ![0,1,2,255].includes(p.getUint8(32))||p.getUint8(33)>2)throw Error('Invalid ECG register report');
  const gain=p.getUint16(30,true),rate=p.getUint16(28,true),selectedGain=p.getUint16(34,true);
  if((gain!==0&&!validGain(gain))||(rate!==0&&rate!==256)||!validGain(selectedGain))throw Error('Unsupported ECG register configuration');
  const readTimeUs=Number(p.getBigUint64(92,true));if(!Number.isSafeInteger(readTimeUs))throw Error('Invalid readback time');
  return {bootId:p.getUint32(0,true),requestId:p.getUint16(4,true),timeUs:frame.timeUs,readTimeUs,validMask:p.getUint8(7),
    registers:Array.from({length:4},(_,i)=>p.getUint32(8+i*4,true)),status:p.getUint32(24,true),rate,gain,
    source:p.getUint8(32),selectedSource:p.getUint8(33),selectedGain,error:p.getInt32(36,true),
    min:p.getInt32(40,true),max:p.getInt32(44,true),samples:p.getUint32(48,true),
    tags:Array.from({length:8},(_,i)=>p.getUint32(52+i*4,true)),clipped:p.getUint32(84,true),revision:p.getUint32(88,true),runRevision:p.getUint32(100,true)};
}
export function decodeFrame(view: DataView): Frame {
  if (view.byteLength < HEADER || view.getUint8(0)!==0xa7 || view.getUint8(1)!==VERSION) throw new Error('Incompatible device protocol. TX Phase 1 firmware is required.');
  const length=view.getUint16(6,true);
  if (length+HEADER!==view.byteLength || view.byteLength>MAX_FRAME) throw new Error('Invalid frame length');
  const time=view.getBigUint64(8,true);
  if (time>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Device timestamp out of range');
  return {type:view.getUint8(2), flags:view.getUint8(3),seq:view.getUint16(4,true),timeUs:Number(time),
    payload:new DataView(view.buffer,view.byteOffset+HEADER,length)};
}
export function decodeStatus(frame: Frame): Status {
  const p=frame.payload;
  if (frame.type!==Message.STATUS || p.byteLength!==48 || p.getUint8(36)>1 || p.getUint8(37)>2) throw new Error('Invalid device status');
  if (p.getUint16(40,true)!==256 || p.getUint16(42,true)!==100) throw new Error('Unsupported device sampling configuration');
  return {bootId:p.getUint32(0,true),capabilities:p.getUint32(4,true),available:p.getUint32(8,true),faults:p.getUint32(12,true),
    droppedSamples:p.getUint32(16,true),droppedFrames:p.getUint32(20,true),ecgOverflows:p.getUint32(24,true),ppgOverflows:p.getUint32(28,true),
    ecgStatus:p.getUint32(32,true),monitoring:!!p.getUint8(36),power:p.getUint8(37),red:p.getUint8(38),ir:p.getUint8(39),
    ecgRate:p.getUint16(40,true),ppgRate:p.getUint16(42,true),mtu:p.getUint16(44,true),timeUs:frame.timeUs,
    // Capability bit 7 adds a live channel mask without changing v1 frame size.
    activeSensors:p.getUint8(36) ? ((p.getUint32(4,true)&128) ? p.getUint8(46)&7 : p.getUint32(8,true)&~p.getUint32(12,true)&7) : 0};
}
const raw24=(p: DataView,o: number)=>p.getUint8(o)|(p.getUint8(o+1)<<8)|(p.getUint8(o+2)<<16);
export function decodeSamples(frame: Frame): Sample[] {
  const p=frame.payload;
  if (frame.type===Message.ECG || frame.type===Message.ECG_META || frame.type===Message.PPG) {
    if (p.byteLength<8) throw new Error('Incomplete sample header');
    const meta=frame.type===Message.ECG_META,ecg=frame.type!==Message.PPG, index=p.getUint32(0,true),rate=p.getUint16(4,true),count=p.getUint8(6),width=p.getUint8(7),header=meta?12:8;
    if (rate!==(ecg?256:100) || !count || count>12 || width!==(ecg?4:7) || p.byteLength!==header+count*width) throw new Error('Invalid sample configuration or length');
    const gain=meta?p.getUint16(8,true):undefined,source=meta?p.getUint8(10):undefined;
    if(meta&&(!validGain(gain!)||source!>2||p.getUint8(11)!==1))throw Error('Invalid ECG gain/source metadata');
    return Array.from({length:count},(_,i)=>{
      const offset=header+i*width,raw=raw24(p,offset),flags=p.getUint8(offset+width-1);
      // Match firmware's rational integer clock, including the fractional phase of index0.
      const timeUs=frame.timeUs+Math.floor((index+i)*1e6/rate)-Math.floor(index*1e6/rate);
      if (ecg) {
        const tag=(raw>>3)&7,value=raw>>>6;
        if (tag>3) throw new Error('Invalid ECG FIFO tag');
        const a=value&0x20000?value-0x40000:value;
        return {type:'ecg',timeUs,index:(index+i)>>>0,a,b:raw,tag,flags,gain,source,rate,
          inputMv:countsToMv(a,gain),valid:(tag===0||tag===2)&&!(flags&8)&&!(flags&16)&&(!meta||source===0)};
      }
      const ir=raw24(p,offset+3);
      if (raw>0x3ffff || ir>0x3ffff) throw new Error('PPG sample exceeds 18-bit range');
      return {type:'ppg',timeUs,index:(index+i)>>>0,a:raw,b:ir,flags,valid:!(flags&8)};
    });
  }
  if (frame.type===Message.TEMP || frame.type===Message.RR) {
    if (p.byteLength!==12) throw new Error('Invalid measurement length');
    const rr=frame.type===Message.RR;
    const raw=p.getUint32(0,true);
    if (rr && (!raw || raw>0x3fff)) throw new Error('Invalid R-R register value');
    return [{type:rr?'rr':'temperature',timeUs:frame.timeUs,index:p.getUint32(8,true),
      a:rr?raw*7.8125:p.getInt32(0,true)/1000,b:rr?p.getUint32(4,true):p.getInt32(4,true)/1000,
      flags:frame.flags,valid:rr ? !!(frame.flags&4) && !(p.getUint32(4,true)&0x30010f) : true}];
  }
  throw new Error('Unknown measurement type');
}
export function command(type: Message,id: number,payload: number[]=[]): Uint8Array<ArrayBuffer> {
  const valid=(type===Message.MONITOR||type===Message.POWER) ? payload.length===1 && (payload[0]===0||payload[0]===1) :
    type===Message.CONFIG ? payload.length===3 && ((payload[0]===1 && payload.slice(1).every(v=>Number.isInteger(v)&&v>=0&&v<=127))||
      (payload[0]===2&&validGain(payload[1])&&[0,1,2].includes(payload[2]))) :
    (type===Message.QUERY||type===Message.ECG_QUERY) && payload.length===0;
  if (!valid) throw new Error('Invalid command parameters');
  const p=new Uint8Array(8+payload.length),v=new DataView(p.buffer);
  p.set([0xc7,VERSION,type,payload.length]);v.setUint16(4,id,true);p.set(payload,8);return p;
}
/** Strict ordered fragments. Missing/duplicate fragments discard a frame, never fabricate samples. */
export class Reassembler {
  private buffer=new Uint8Array(MAX_FRAME);
  private size=0;
  private id=-1;
  private expected=0;
  private lastSeq: number|null=null;
  dropped=0;
  reset() { this.size=0;this.id=-1;this.expected=0;this.lastSeq=null;this.dropped=0; }
  push(p: DataView): Frame|null {
    if (p.byteLength<=6 || p.getUint8(0)!==0xd7 || p.getUint8(1)!==VERSION) throw new Error('Incompatible notification protocol');
    const id=p.getUint16(2,true),offset=p.getUint16(4,true),bytes=p.byteLength-6;
    if (offset===0) {
      if (this.size) this.dropped++;
      this.id=id;this.size=0;this.expected=0;
    }
    if (id!==this.id || offset!==this.size || offset+bytes>MAX_FRAME) {
      this.size=0;this.id=-1;this.dropped++;return null;
    }
    this.buffer.set(new Uint8Array(p.buffer,p.byteOffset+6,bytes),offset);this.size+=bytes;
    if (this.size>=HEADER && !this.expected) {
      const head=new DataView(this.buffer.buffer);
      this.expected=HEADER+head.getUint16(6,true);
      if (this.expected>MAX_FRAME || head.getUint8(0)!==0xa7 || head.getUint8(1)!==VERSION || head.getUint16(4,true)!==id) {
        this.size=0;this.id=-1;throw new Error('Corrupted fragment header');
      }
    }
    if (this.expected && this.size>this.expected) { this.size=0;this.id=-1;throw new Error('Fragment exceeds frame length'); }
    if (this.expected && this.size===this.expected) {
      const view=new DataView(this.buffer.slice(0,this.size).buffer);
      this.size=0;this.id=-1;this.expected=0;
      if (this.lastSeq!==null) {
        const delta=(id-this.lastSeq)&0xffff;
        if (!delta || delta>0x8000) { this.dropped++;return null; }
        this.dropped+=delta-1;
      }
      this.lastSeq=id;return decodeFrame(view);
    }
    return null;
  }
}
