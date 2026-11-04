// Separate optional service. The existing Phase 1 UUIDs and frame bytes are unchanged.
export const GATEWAY_UUID='7f510001-1b15-4f1b-9e90-77a4c9b5a200';
export const GATEWAY_WRITE='7f510002-1b15-4f1b-9e90-77a4c9b5a200';
export const GATEWAY_NOTIFY='7f510003-1b15-4f1b-9e90-77a4c9b5a200';
export const GATEWAY_VERSION=2;
export enum StimOp {Query=1,Configure,Start,Stop,Keepalive}
export type StimParameters={currentUa:number;frequencyMhz:number;widthUs:number;durationMs:number};
export type StimLimits={currentUa:number;minFrequencyMhz:number;maxFrequencyMhz:number;minWidthUs:number;maxWidthUs:number;durationMs:number};
export type RxState={id:number;op:number;result:number;state:number;flags:number;nonce:number;vddMv:number;vrectMv:number;remainingMs:number};
export type GatewayState={state:number;security:number;flags:number;error:number;ageMs:number;nonce:number;failureStage?:number;retryMs?:number};
export type GatewayPacket={type:'rx';value:RxState}|{type:'gateway';value:GatewayState}|{type:'parameters';value:StimParameters;nonce:number;id:number}|{type:'limits';value:StimLimits}|{type:'reject';id:number;op:number;result:number};
export const STIM_RESULTS=['OK','Invalid frame','Outside RX limits','RX not ready','Link not permitted','Supply unstable','Command/lease timeout','Hardware error','Busy','Stale session','RX output is not configured'];
export function gatewayLinkError(g:GatewayState|null):string|null {
  if(!g||!(g.flags&1)||!g.error)return null;
  const failures=['RX link error','RX scan failed','RX connection failed','RX service discovery failed',
    'RX characteristic discovery failed','RX notification descriptor not found','RX notification subscription failed',
    'No RX status received','RX protocol mismatch','RX link disconnected','RX disconnect failed','RX event queue full',
    'TX phone disconnected','Wireless Power is off','Stimulation heartbeat timed out','RX command write failed'];
  const stage=g.failureStage??0;
  const code=g.error>0&&[2,9].includes(stage)?`HCI 0x${g.error.toString(16).padStart(2,'0')}`:
    g.error>0&&stage===6?`ATT 0x${g.error.toString(16).padStart(2,'0')}`:`code ${g.error}`;
  return `${failures[stage]??failures[0]} (${code})`;
}
export function decodeGateway(v:DataView):GatewayPacket {
  if(v.byteLength!==20||v.getUint8(0)!==GATEWAY_VERSION)throw Error('Update TX and RX to the same direct-link firmware');
  const u16=(i:number)=>v.getUint16(i,true),u32=(i:number)=>v.getUint32(i,true),type=v.getUint8(1);
  if(type===0x80){const flags=u16(6),state=(flags>>8)&7;if(state>4||v.getUint8(4)>5||v.getUint8(5)>10||(flags&~0x077f))throw Error('Invalid RX state');return {type:'rx',value:{id:u16(2),op:v.getUint8(4),result:v.getUint8(5),flags,state,nonce:u32(8),vddMv:u16(12),vrectMv:u16(14),remainingMs:u32(16)}};}
  if(type===0x81)return {type:'parameters',id:u16(2),nonce:u32(4),value:{currentUa:u16(8),frequencyMhz:u32(10),widthUs:u16(14),durationMs:u32(16)}};
  if(type===0x82)return {type:'gateway',value:{state:v.getUint8(2),security:v.getUint8(3),flags:u16(4),error:v.getInt16(6,true),ageMs:u32(8),nonce:u32(12),failureStage:v.getUint8(16),retryMs:u16(18)}};
  if(type===0x83)return {type:'limits',value:{currentUa:u16(2),minFrequencyMhz:u32(4),maxFrequencyMhz:u32(8),minWidthUs:u16(12),maxWidthUs:u16(14),durationMs:u32(16)}};
  if(type===0x84){if(v.getUint8(5)===0&&v.getUint8(4)!==StimOp.Query)throw Error('TX cannot confirm an RX mutation');return {type:'reject',id:u16(2),op:v.getUint8(4),result:v.getUint8(5)};}
  throw Error('Unknown stimulation packet');
}
export function validStimParameters(p:StimParameters,l:StimLimits|null):boolean {
  return !!l&&Object.values(p).every(n=>Number.isSafeInteger(n)&&n>0)&&p.currentUa<=l.currentUa&&p.currentUa<=65535&&
    p.frequencyMhz>=l.minFrequencyMhz&&p.frequencyMhz<=l.maxFrequencyMhz&&p.frequencyMhz<=0xffffffff&&
    p.widthUs>=l.minWidthUs&&p.widthUs<=l.maxWidthUs&&p.widthUs<=65535&&p.durationMs<=l.durationMs&&
    p.durationMs<=Math.floor(0xffffffff/1000)&&Math.round(1e9/p.frequencyMhz)<=0xffffffff&&p.widthUs+2<Math.round(1e9/p.frequencyMhz);
}
export function stimulationCommand(op:StimOp,id:number,nonce:number,p?:StimParameters):Uint8Array<ArrayBuffer> {
  if(!Number.isInteger(id)||id<0||id>=65535||!Number.isInteger(nonce)||nonce<0||nonce>0xffffffff)throw Error('Invalid stimulation transaction');
  if(op<1||op>5||(op===StimOp.Configure&&!p))throw Error('Invalid stimulation command');
  if(p&&(op!==StimOp.Configure||!Object.values(p).every(n=>Number.isSafeInteger(n)&&n>0)||p.currentUa>65535||p.widthUs>65535||p.frequencyMhz>0xffffffff||p.durationMs>0xffffffff))throw Error('Stimulation parameters exceed wire representation');
  const bytes=new Uint8Array(20),v=new DataView(bytes.buffer);bytes[0]=GATEWAY_VERSION;bytes[1]=op;v.setUint16(2,id,true);v.setUint32(4,nonce,true);
  if(p){v.setUint16(8,p.currentUa,true);v.setUint32(10,p.frequencyMhz,true);v.setUint16(14,p.widthUs,true);v.setUint32(16,p.durationMs,true);}return bytes;
}
