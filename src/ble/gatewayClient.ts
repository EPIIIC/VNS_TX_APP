import type {TxClient} from './client';
import {decodeGateway,GATEWAY_UUID,GATEWAY_NOTIFY,GATEWAY_WRITE,STIM_RESULTS,StimOp,stimulationCommand,type GatewayPacket,type StimParameters} from './gatewayProtocol';
type Callbacks={packet:(p:GatewayPacket)=>void;link:(available:boolean)=>void;error:(message:string|null)=>void;ack:(message:string)=>void};
export class GatewayClient {
  private notify:BluetoothRemoteGATTCharacteristic|null=null;
  private write:BluetoothRemoteGATTCharacteristic|null=null;
  private epoch=0;private id=0;private nonce=0;
  private pending?:{id:number;op:number;acked?:boolean;parameters?:boolean;local?:boolean;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
  private lease?:ReturnType<typeof setInterval>;
  private lastRxAt=0;
  constructor(private tx:TxClient,private cb:Callbacks){}
  async attach() {
    this.dispose();const epoch=this.epoch;
    try {
      await this.tx.gatewayGatt(async server=>{
        const service=await server.getPrimaryService(GATEWAY_UUID);
        const notify=await service.getCharacteristic(GATEWAY_NOTIFY),write=await service.getCharacteristic(GATEWAY_WRITE);
        const initial=await notify.readValue();if(epoch!==this.epoch)return;
        this.notify=notify;this.write=write;this.cb.packet(decodeGateway(initial));
        notify.addEventListener('characteristicvaluechanged',this.receive);
        await notify.startNotifications();
        if(epoch!==this.epoch){notify.removeEventListener('characteristicvaluechanged',this.receive);return;}
        this.cb.link(true);
      });
    } catch {if(epoch===this.epoch){this.write=null;this.cb.link(false);}}
  }
  private receive=(event:Event)=>{
    const characteristic=event.target as BluetoothRemoteGATTCharacteristic;
    if(characteristic!==this.notify||!characteristic.value)return;
    try {
      const p=decodeGateway(characteristic.value);
      if(p.type==='gateway'&&(!(p.value.flags&1)||(p.value.flags&84)!==84))this.endLease();
      if(p.type==='rx') {
        this.lastRxAt=Date.now();
        if(this.nonce&&this.nonce!==p.value.nonce)this.endLease();this.nonce=p.value.nonce;
        if(p.value.state===0||p.value.state>=3||p.value.result)this.endLease();
      }
      this.cb.packet(p);
      if(p.type==='parameters'&&this.pending?.op===StimOp.Configure&&p.id===this.pending.id&&p.nonce===this.nonce){this.pending.parameters=true;this.complete();}
      if((p.type==='rx'||p.type==='reject')&&this.pending) {
        const id=p.type==='rx'?p.value.id:p.id,op=p.type==='rx'?p.value.op:p.op,result=p.type==='rx'?p.value.result:p.result;
        if(id===this.pending.id&&op===this.pending.op) {
          if(result){const pending=this.pending;this.pending=undefined;clearTimeout(pending.timer);pending.reject(Error(STIM_RESULTS[result]??`RX error ${result}`));
            if(op!==StimOp.Keepalive)this.cb.ack(`${StimOp[op]}: ${STIM_RESULTS[result]??result}`);
          }else{this.pending.acked=true;this.pending.local=p.type==='reject';this.complete();}
        }
      }
    } catch(e){this.endLease();this.cb.error(e instanceof Error?e.message:String(e));}
  };
  private complete() {
    const p=this.pending;if(!p?.acked||(p.op===StimOp.Configure&&!p.parameters))return;
    this.pending=undefined;clearTimeout(p.timer);p.resolve();
    if(p.op!==StimOp.Keepalive)this.cb.ack(`${p.local?'TX':'RX'} ${StimOp[p.op]}: OK`);
  }
  private clearPending(id:number) {
    const pending=this.pending;
    if(pending?.id===id){clearTimeout(pending.timer);this.pending=undefined;}
  }
  async command(op:StimOp,p?:StimParameters) {
    if(!this.write)throw Error('Stimulation Gateway is unavailable on this TX firmware');
    if(op===StimOp.Stop){this.endLease();this.pending?.reject(Error('Cancelled by STOP'));if(this.pending)clearTimeout(this.pending.timer);this.pending=undefined;}
    if(this.pending)throw Error('Wait for the RX acknowledgement');
    const epoch=this.epoch,id=this.id++%65535,packet=stimulationCommand(op,id,this.nonce,p);
    const acknowledged=new Promise<void>((resolve,reject)=>{this.pending={id,op,resolve,reject,timer:setTimeout(()=>{
      if(this.pending?.id===id){this.pending=undefined;this.endLease();this.cb.error('RX acknowledgement timed out. Output is not confirmed.');reject(Error('RX acknowledgement timed out'));}
    },2500)};});void acknowledged.catch(()=>{});
    try {
      await this.tx.gatewayGatt(async()=>{if(epoch!==this.epoch||!this.write)throw Error('Connection changed');await this.write.writeValueWithResponse(packet);});
      await acknowledged;
      if(op===StimOp.Start&&epoch===this.epoch)this.beginLease();
    } catch(e) {
      this.clearPending(id);
      this.endLease();throw e;
    }
  }
  private beginLease() {
    this.endLease();this.lease=setInterval(()=>{
      if(document.hidden||Date.now()-this.lastRxAt>2500){this.endLease();return;}
      if(!this.pending)void this.command(StimOp.Keepalive).catch(e=>this.cb.error(e instanceof Error?e.message:String(e)));
    },500);
  }
  endLease(){clearInterval(this.lease);this.lease=undefined;}
  dispose() {
    this.epoch++;this.endLease();this.nonce=0;this.lastRxAt=0;
    this.notify?.removeEventListener('characteristicvaluechanged',this.receive);this.notify=null;this.write=null;
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(Error('Gateway disconnected'));this.pending=undefined;}
    this.cb.link(false);
  }
}
