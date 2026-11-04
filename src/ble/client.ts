import { command, decodeSamples, decodeStatus, decodeEcgInfo, EcgInfo, Frame, Message, NOTIFY_UUID, Reassembler, SERVICE_UUID, Status, WRITE_UUID, Sample } from './protocol';
import {GATEWAY_UUID} from './gatewayProtocol';

type Callbacks = {
  link: (label: string, connected: boolean, name?: string) => void;
  status: (status: Status) => void;
  samples: (samples: Sample[]) => void;
  error: (message: string|null) => void;
  busy: (busy: boolean) => void;
  loss: (count: number) => void;
  ecgInfo?: (info:EcgInfo)=>void;
};
const errorText=(e: unknown)=>e instanceof Error?e.message:String(e);
class CommandRejected extends Error {}
type StatusWaiter = { promise:Promise<Status>; resolve:(value:Status)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout> };
function bounded<T>(promise: Promise<T>,ms: number): Promise<T> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Bluetooth timed out. Reconnect to confirm device state.')),ms);
    promise.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
  });
}
export class TxClient {
  private target: BluetoothDevice|null=null;
  private tx: BluetoothRemoteGATTCharacteristic|null=null;
  private rx: BluetoothRemoteGATTCharacteristic|null=null;
  private ready=false;
  private epoch=0;
  private disposed=false;
  private connecting=false;
  private powerTimer?: ReturnType<typeof setTimeout>;
  private powerWanted=false;
  private powerIntent=0;
  private queue: Promise<unknown>=Promise.resolve();
  private requestId=0;
  private reassembly=new Reassembler();
  private pending?: { id:number; type:Message; resolve:()=>void; reject:(e:Error)=>void; timer:ReturnType<typeof setTimeout> };
  private lastStatus: Status|null=null;
  private statusWaiter?: StatusWaiter;
  private ecgWaiter?:{id:number;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
  constructor(private cb: Callbacks,private bluetooth: Bluetooth|undefined,private timeoutMs=3000) {}
  private check(epoch:number) {
    if (this.disposed || epoch!==this.epoch) throw new Error('Connection changed. The previous operation was cancelled.');
  }
  private select(device:BluetoothDevice) {
    this.target?.removeEventListener('gattserverdisconnected',this.disconnected);
    this.target=device;device.addEventListener('gattserverdisconnected',this.disconnected);
  }
  async connect() {
    if (!this.bluetooth) throw new Error('Web Bluetooth is unavailable. Use a compatible Chrome browser over HTTPS or localhost.');
    if(this.connecting)return;
    this.connecting=true;this.disconnect();this.cb.busy(true);
    const epoch=this.epoch;
    this.cb.error(null);this.cb.link('Requesting Device...',false);
    try {
      const device=await this.bluetooth.requestDevice({filters:[{services:[SERVICE_UUID],namePrefix:'VNS_TX'}],optionalServices:[GATEWAY_UUID]});
      this.check(epoch);this.select(device);await this.open();
    } catch(e) {
      if(epoch===this.epoch&&!this.disposed) { this.cb.link('Disconnected',false);this.cb.error(errorText(e)); }
    } finally {
      this.connecting=false;if(!this.disposed)this.cb.busy(false);
    }
  }
  private async open() {
    const device=this.target;if(!device?.gatt)throw new Error('No Bluetooth GATT server.');
    const epoch=this.epoch;
    this.cb.link('Connecting to GATT...',false,device.name);
    this.reassembly.reset();this.lastStatus=null;
    try {
      const connecting=device.gatt.connect();
      // A timeout cannot cancel Web Bluetooth. Close a late result from an obsolete attempt.
      void connecting.then(server=>{if(epoch!==this.epoch||this.disposed)server.disconnect();},()=>{});
      const server=await bounded(connecting,this.timeoutMs);this.check(epoch);
      const service=await bounded(server.getPrimaryService(SERVICE_UUID),this.timeoutMs);this.check(epoch);
      const tx=await bounded(service.getCharacteristic(NOTIFY_UUID),this.timeoutMs);this.check(epoch);
      const rx=await bounded(service.getCharacteristic(WRITE_UUID),this.timeoutMs);this.check(epoch);
      this.tx=tx;this.rx=rx;
      // Register before enabling CCC: the first status may arrive before
      // startNotifications resolves. Never read this active Notify characteristic;
      // Web Bluetooth/CoreBluetooth routes reads and notifications together.
      const handshake=this.waitForStatus();
      tx.addEventListener('characteristicvaluechanged',this.notification);
      await bounded(tx.startNotifications(),this.timeoutMs);this.check(epoch);
      await handshake.promise;this.check(epoch);
      this.ready=true;
      this.cb.link('Connected',true,device.name);this.cb.error(null);
    } catch(e) {
      if(epoch===this.epoch&&!this.disposed) {
        this.epoch++;this.clear();
        device.removeEventListener('gattserverdisconnected',this.disconnected);device.gatt.disconnect();
        device.addEventListener('gattserverdisconnected',this.disconnected);
        this.cb.link('Connection failed',false,device.name);
        this.cb.error(errorText(e));
      }
      throw e;
    }
  }
  private clear() {
    this.ready=false;this.powerWanted=false;this.powerIntent++;
    this.tx?.removeEventListener('characteristicvaluechanged',this.notification);this.tx=null;this.rx=null;
    clearTimeout(this.powerTimer);
    if(this.statusWaiter)this.cancelStatus(this.statusWaiter,new Error('Connection lost while waiting for TX status.'));
    if(this.pending) { clearTimeout(this.pending.timer);this.pending.reject(new Error('Connection lost. Command result is unknown.'));this.pending=undefined; }
    if(this.ecgWaiter){clearTimeout(this.ecgWaiter.timer);this.ecgWaiter.reject(new Error('Connection lost during ECG readback'));this.ecgWaiter=undefined;}
    this.reassembly.reset();this.lastStatus=null;
    // Old queued operations retain their old epoch and will reject before any GATT I/O.
  }
  private waitForStatus():StatusWaiter {
    if(this.statusWaiter)throw new Error('A TX status request is already pending.');
    let resolve!:(value:Status)=>void,reject!:(error:Error)=>void;
    const promise=new Promise<Status>((yes,no)=>{resolve=yes;reject=no;});
    const waiter:StatusWaiter={promise,resolve,reject,timer:setTimeout(()=>{
      this.cancelStatus(waiter,new Error('No valid TX status notification received. Reconnect and check the device connection.'));
    },this.timeoutMs)};
    this.statusWaiter=waiter;
    // CCC setup / command write can still be pending when the timeout fires.
    void promise.catch(()=>{});
    return waiter;
  }
  private cancelStatus(waiter:StatusWaiter,error:Error) {
    if(this.statusWaiter!==waiter)return;
    this.statusWaiter=undefined;clearTimeout(waiter.timer);waiter.reject(error);
  }
  private disconnected=(e:Event)=>{
    if(this.disposed || e.target!==this.target)return;
    this.epoch++;this.clear();this.cb.link('Disconnected',false);
    this.cb.error('Connection lost. Click Connect to reconnect. Monitoring and power remain off.');
  };
  private fail(e:unknown,epoch:number) {
    if(epoch!==this.epoch||this.disposed)return;
    const device=this.target;
    this.epoch++;this.clear();
    device?.removeEventListener('gattserverdisconnected',this.disconnected);device?.gatt?.disconnect();
    device?.addEventListener('gattserverdisconnected',this.disconnected);
    this.cb.error(errorText(e));this.cb.link('Connection error',false);
  }
  private notification=(e:Event)=>{
    const characteristic=e.target as BluetoothRemoteGATTCharacteristic;
    if(this.disposed||characteristic!==this.tx||!characteristic.value)return;
    try {
      const frame=this.reassembly.push(characteristic.value);
      this.cb.loss(this.reassembly.dropped);
      if(frame)this.handle(frame);
    } catch(e) { this.fail(e,this.epoch); }
  };
  private handle(frame:Frame) {
    if(frame.type===Message.STATUS) {
      const status=decodeStatus(frame);
      if(this.lastStatus && status.bootId!==this.lastStatus.bootId) throw new Error('Device restarted. Reconnect to confirm state.');
      this.lastStatus=status;
      if(status.power===0 || status.faults) { this.powerWanted=false;clearTimeout(this.powerTimer); }
      this.cb.status(status);
      if(this.statusWaiter){const waiter=this.statusWaiter;this.statusWaiter=undefined;clearTimeout(waiter.timer);waiter.resolve(status);}
    } else if(frame.type===Message.ECG_INFO) {
      const info=decodeEcgInfo(frame);
      if(this.lastStatus&&info.bootId!==this.lastStatus.bootId)throw Error('ECG report belongs to another device boot');
      this.cb.ecgInfo?.(info);
      if(this.ecgWaiter?.id===info.requestId){clearTimeout(this.ecgWaiter.timer);this.ecgWaiter.resolve();this.ecgWaiter=undefined;}
    } else if(frame.type===Message.ACK||frame.type===Message.ERROR) {
      const p=frame.payload;if(p.byteLength!==8)throw new Error('Invalid ACK length');
      if(this.pending && this.pending.id===p.getUint16(0,true) && this.pending.type===p.getUint8(2)) {
        const pending=this.pending;this.pending=undefined;clearTimeout(pending.timer);
        if(frame.type===Message.ACK && p.getUint8(3)===0)pending.resolve();
        else pending.reject(new CommandRejected(`Device rejected command: ${['Success','Invalid parameters','Stop monitoring first','Sensor or bus fault','Power conditions not met','Unsupported feature','Stale command'][p.getUint8(3)]??'Unknown error'} (${p.getInt32(4,true)})`));
      }
    } else if(this.ready) { this.cb.samples(decodeSamples(frame)); }
  }
  private serialize<T>(fn:()=>Promise<T>):Promise<T> {
    const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;
  }
  /** Serialize ATT operations across both services; never hold this queue while waiting for RX ACK. */
  gatewayGatt<T>(operation:(server:BluetoothRemoteGATTServer)=>Promise<T>):Promise<T> {
    const epoch=this.epoch;
    return this.serialize(async()=>{
      this.check(epoch);if(!this.ready||!this.target?.gatt?.connected)throw Error('Connect to TX first');
      const result=await bounded(operation(this.target.gatt),30000);this.check(epoch);return result;
    });
  }
  private send(type:Message,data:number[],silent=false,guard?:()=>boolean,statusResponse=false,ecgResponse=false):Promise<void> {
    const epoch=this.epoch;
    return this.serialize(async()=>{
      this.check(epoch);if(!this.ready||!this.rx)throw new Error('Connect to a TX device first');
      if(guard&&!guard())throw new Error('Operation cancelled');
      if(!silent)this.cb.busy(true);
      // 0xffff identifies unsolicited ECG_INFO, never a requested SPI readback.
      if((this.requestId&0xffff)===0xffff)this.requestId++;
      const id=this.requestId++&0xffff;
      const ecgReport=ecgResponse?new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{this.ecgWaiter=undefined;reject(new Error('No fresh ECG register report received'));},this.timeoutMs);
        this.ecgWaiter={id,resolve,reject,timer};
      }):undefined;
      void ecgReport?.catch(()=>{});
      const status=statusResponse?this.waitForStatus():undefined;
      const acknowledged=new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{if(this.pending?.id===id)this.pending=undefined;reject(new Error('No command acknowledgement. Disconnected; the command will not be retried.'));},this.timeoutMs);
        this.pending={id,type,resolve,reject,timer};
      });
      // Prevent unhandled rejection if write itself stalls before ACK is awaited.
      void acknowledged.catch(()=>{});
      try {
        await bounded(this.rx.writeValueWithResponse(command(type,id,data)),this.timeoutMs);this.check(epoch);
        await acknowledged;this.check(epoch);
        if(status){await status.promise;this.check(epoch);}
        if(ecgReport){await ecgReport;this.check(epoch);}
      } catch(e) {
        if(e instanceof CommandRejected)this.cb.error(e.message);else this.fail(e,epoch);
        throw e;
      } finally {
        if(this.pending?.id===id){clearTimeout(this.pending.timer);this.pending=undefined;}
        if(status)this.cancelStatus(status,new Error('TX status request cancelled.'));
        if(this.ecgWaiter?.id===id){clearTimeout(this.ecgWaiter.timer);this.ecgWaiter.reject(new Error('ECG readback cancelled'));this.ecgWaiter=undefined;}
        if(!silent)this.cb.busy(false);
      }
    });
  }
  async monitor(on:boolean) {
    if(!on){this.powerWanted=false;this.powerIntent++;clearTimeout(this.powerTimer);}
    await this.send(Message.MONITOR,[on?1:0]);
  }
  async power(on:boolean) {
    this.powerWanted=false;clearTimeout(this.powerTimer);
    const intent=++this.powerIntent;
    await this.send(Message.POWER,[on?1:0],false,()=>intent===this.powerIntent);
    if(on&&intent===this.powerIntent&&this.ready){this.powerWanted=true;this.schedulePower();}
  }
  private schedulePower() {
    clearTimeout(this.powerTimer);
    if(!this.powerWanted||!this.ready)return;
    const intent=this.powerIntent;
    this.powerTimer=setTimeout(async()=>{
      try { await this.send(Message.POWER,[1],true,()=>this.powerWanted&&intent===this.powerIntent); }
      catch { this.powerWanted=false; }
      this.schedulePower();
    },1000);
  }
  releasePower() {
    const wasOn=this.powerWanted || !!this.lastStatus?.power;
    this.powerWanted=false;this.powerIntent++;clearTimeout(this.powerTimer);
    if(wasOn&&this.ready)void this.send(Message.POWER,[0],true).catch(()=>{});
  }
  async configure(red:number,ir:number) { await this.send(Message.CONFIG,[1,red,ir]); }
  async configureEcg(gain:number,source:number) {await this.send(Message.CONFIG,[2,gain,source]);await this.readEcg();}
  async readEcg() {return this.send(Message.ECG_QUERY,[],false,undefined,false,true);}
  async refresh() {
    // GET_STATUS has no actuator side effect. Await its ACK and a fresh status,
    // using the same notification decoder as the initial handshake.
    return this.send(Message.QUERY,[],true,undefined,true);
  }
  disconnect() {
    this.epoch++;this.clear();this.target?.removeEventListener('gattserverdisconnected',this.disconnected);
    this.target?.gatt?.disconnect();this.target=null;
    this.cb.link('Disconnected',false);
  }
  dispose() { this.disconnect();this.disposed=true; }
}
