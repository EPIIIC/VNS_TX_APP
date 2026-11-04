import {useEffect,useState,type ChangeEvent} from 'react';
import {Bluetooth,Play,RefreshCw,Square} from 'lucide-react';
import {Button,Card,CardContent,CardHeader,CardTitle,Input,Label} from './ui';
import {StimOp,STIM_RESULTS,validStimParameters,gatewayLinkError,type GatewayState,type RxState,type StimLimits,type StimParameters} from '../ble/gatewayProtocol';
type Props={txConnected:boolean;available:boolean;gateway:GatewayState|null;rx:RxState|null;
  limits:StimLimits|null;applied:StimParameters|null;receivedAt:number;ack:string;error:string|null;send:(op:StimOp,p?:StimParameters)=>Promise<void>};
const LINK=['Unavailable','Power off','Scanning','Connecting','Checking','Discovering','Connected','Reconnecting'];
const STATES=['Stopped','Settling','Running','Not configured','Fault'];
export function StimulationPanel(p:Props) {
  const [current,setCurrent]=useState('1'),[frequency,setFrequency]=useState('15'),[width,setWidth]=useState('250'),[duration,setDuration]=useState('30');
  const [busy,setBusy]=useState(false),[configured,setConfigured]=useState(false),[localError,setLocalError]=useState<string|null>(null);
  const [clock,setClock]=useState(Date.now());
  useEffect(()=>{const t=setInterval(()=>setClock(Date.now()),500);return()=>clearInterval(t);},[]);
  useEffect(()=>{if(!p.rx||p.rx.state>=3||p.rx.result)setConfigured(false);},[p.rx]);
  useEffect(()=>setConfigured(false),[p.txConnected,p.rx?.nonce]);
  const params:StimParameters={currentUa:Math.round(Number(current)*1000),frequencyMhz:Math.round(Number(frequency)*1000),widthUs:Number(width),durationMs:Math.round(Number(duration)*1000)};
  const valid=validStimParameters(params,p.limits)&&duration!=='';
  const linked=!!p.gateway&&(p.gateway.flags&84)===84&&p.gateway.state===6&&p.gateway.nonce!==0&&p.gateway.nonce===p.rx?.nonce;
  const fresh=clock-p.receivedAt<2500&&!!p.gateway&&p.gateway.ageMs<2500;
  const phoneAllowed=!!p.gateway&&(p.gateway.flags&128)!==0;
  // READY, hardware, parameters and link; this RX has no voltage monitor.
  const ready=linked&&fresh&&!!p.rx&&(p.rx.flags&89)===89;
  const running=p.rx?.state===1||p.rx?.state===2;
  const startAllowed=p.txConnected&&ready&&phoneAllowed&&valid&&configured&&!!p.applied&&!!(p.rx!.flags&32)&&p.rx!.state===0&&!busy;
  const error=gatewayLinkError(p.gateway)||localError||p.error||(p.rx?.result&&fresh?`RX: ${STIM_RESULTS[p.rx.result]??'Unknown error'}`:null);
  const perform=async(op:StimOp)=>{
    setBusy(true);setLocalError(null);
    try{await p.send(op,op===StimOp.Configure?params:undefined);if(op===StimOp.Configure)setConfigured(true);if(op===StimOp.Stop)setConfigured(false);}
    catch(e){setConfigured(false);setLocalError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  const edit=(set:(v:string)=>void)=>(e:ChangeEvent<HTMLInputElement>)=>{set(e.target.value);setConfigured(false);};
  return <div className="max-w-md mx-auto w-full space-y-3">
    <Card className="rounded-2xl border-slate-200/60 overflow-hidden"><CardHeader className="px-4 py-3 border-b border-slate-100 bg-slate-50/50"><CardTitle className="text-sm flex items-center gap-2"><Bluetooth className="w-4 h-4 text-blue-500"/>Stimulation</CardTitle></CardHeader>
      <CardContent className="px-4 pt-3 pb-4 space-y-3">
        <div className="grid grid-cols-2 gap-2 text-xs text-slate-500"><span>TX: {p.txConnected?'Connected':'Disconnected'}</span><span>RX: {p.available?(LINK[p.gateway?.state??0]??'Unavailable'):'Gateway unavailable'}</span><span>Wireless Power: {p.gateway?(p.gateway.flags&1?'ON':'OFF'):'--'}</span><span>Output: {p.rx&&fresh?STATES[p.rx.state]:'--'}</span></div>
        <div className="text-[10px] text-slate-400">Auto-connect · VNS_RX_01 · No pairing</div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label className="text-xs" htmlFor="stim-current">Current Setpoint (mA)</Label><Input id="stim-current" type="number" min="0" step="0.001" value={current} onChange={edit(setCurrent)} className="mt-1 h-9 rounded-lg"/></div>
          <div><Label className="text-xs" htmlFor="stim-frequency">Pulse Frequency (Hz)</Label><Input id="stim-frequency" type="number" min="0" step="0.001" value={frequency} onChange={edit(setFrequency)} className="mt-1 h-9 rounded-lg"/></div>
          <div><Label className="text-xs" htmlFor="stim-width">Pulse Width (µs)</Label><Input id="stim-width" type="number" min="0" step="1" value={width} onChange={edit(setWidth)} className="mt-1 h-9 rounded-lg"/></div>
          <div><Label className="text-xs" htmlFor="stim-duration">Duration (s)</Label><Input id="stim-duration" type="number" min="0" step="0.001" value={duration} placeholder="Required" onChange={edit(setDuration)} className="mt-1 h-9 rounded-lg"/></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={!p.txConnected||!p.available||busy} onClick={()=>void perform(StimOp.Query)} className="h-9 rounded-xl text-xs"><RefreshCw className="w-3 h-3 mr-1"/>Refresh RX</Button>
          <Button disabled={!ready||!phoneAllowed||!valid||busy||running} onClick={()=>void perform(StimOp.Configure)} className="h-9 rounded-xl text-xs bg-slate-800">Apply Parameters</Button>
          <Button disabled={!startAllowed} onClick={()=>void perform(StimOp.Start)} className="h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-xs"><Play className="w-3 h-3 mr-1"/>START</Button>
          <Button variant="destructive" disabled={!p.txConnected||!p.available} onClick={()=>void perform(StimOp.Stop)} className="h-10 rounded-xl text-xs"><Square className="w-3 h-3 mr-1"/>STOP</Button>
        </div>
        {error&&<div role="alert" className="text-xs text-red-600">{error}</div>}
        {p.available&&p.rx&&fresh&&!(p.rx.flags&16)&&<div className="text-xs text-amber-600">RX output GPIO initialization failed.</div>}
        {p.available&&p.rx&&fresh&&(p.rx.flags&16)!==0&&!(p.rx.flags&8)&&<div className="text-xs text-amber-600">RX output settings are not configured.</div>}
      </CardContent>
    </Card>
    <Card className="rounded-2xl border-slate-200/60"><CardContent className="px-4 py-3 space-y-2 text-xs text-slate-500">
      <div className="font-semibold text-slate-700">RX Applied Setpoint</div>
      <div>{p.applied?`${(p.applied.currentUa/1000).toFixed(3)} mA · ${p.applied.frequencyMhz/1000} Hz · ${p.applied.widthUs} µs · ${p.applied.durationMs/1000} s`:'--'}</div>
      <div>Remaining: {p.rx&&fresh?(p.rx.remainingMs/1000).toFixed(1)+' s':'--'} · ACK: {p.ack||'--'}</div>
      <div className="text-[10px] text-slate-400">Applied values are programmed setpoints, not measured output current.</div>
    </CardContent></Card>
  </div>;
}
