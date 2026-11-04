import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bluetooth, Activity, Droplet, Thermometer, HeartPulse, Settings2, Zap, Radio, LineChart as LineChartIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label } from './components/ui';
import { TxClient } from './ble/client';
import { Sample, Status, EcgInfo, SERVICE_UUID } from './ble/protocol';
import { Waveform } from './components/Waveform';
import { Recording, saveCsv } from './data/recording';
import { faultMessage, measurementFresh } from './data/display';
import { DEFAULT_DISPLAY, DisplayOptions, EcgDisplay, StableEcgScale, type WavePoint } from './data/ecgDisplay';
import {DEFAULT_PPG_DISPLAY,PpgDisplay,type PpgDisplayOptions} from './data/ppgDisplay';

import {ecgMetrics,sourceName} from './data/ecgMeasurements';
import {EcgControls} from './components/EcgControls';
import {PpgControls} from './components/PpgControls';
import {Trend} from './components/Trend';
import {HrvAnalyzer,type TrendPoint} from './data/hrv';
import {Spo2Analyzer} from './data/spo2';
import {ControlPanel} from './components/ControlPanel';
import {StimulationPanel} from './components/StimulationPanel';
import {GatewayClient} from './ble/gatewayClient';
import {StimOp,type GatewayState,type RxState,type StimLimits,type StimParameters} from './ble/gatewayProtocol';

export default function App() {
  const client = useRef<TxClient|null>(null);
  const gateway=useRef<GatewayClient|null>(null),rxNonce=useRef(0);
  const [gatewayAvailable,setGatewayAvailable]=useState(false),[gatewayState,setGatewayState]=useState<GatewayState|null>(null);
  const [rxState,setRxState]=useState<RxState|null>(null),[rxLimits,setRxLimits]=useState<StimLimits|null>(null);
  const [rxApplied,setRxApplied]=useState<StimParameters|null>(null),[rxAck,setRxAck]=useState(''),[rxError,setRxError]=useState<string|null>(null);
  const [rxReceivedAt,setRxReceivedAt]=useState(0);
  const recorder = useRef(new Recording());
  const hrv=useRef(new HrvAnalyzer());
  const spo2=useRef(new Spo2Analyzer());
  const trends=useRef<{temperature:TrendPoint[];hrv:TrendPoint[]}>({temperature:[],hrv:[]});
  const waves = useRef<{ecg:WavePoint[];ppg:WavePoint[]}>({ecg:[],ppg:[]});
  const ecgDisplay=useRef(new EcgDisplay(DEFAULT_DISPLAY));
  const optionsRef=useRef<DisplayOptions>(DEFAULT_DISPLAY);
  const [display,setDisplay]=useState<DisplayOptions>(DEFAULT_DISPLAY);
  const ppgOptionsRef=useRef<PpgDisplayOptions>(DEFAULT_PPG_DISPLAY);
  const ppgFilter=useRef(new PpgDisplay(DEFAULT_PPG_DISPLAY));
  const [ppgDisplay,setPpgDisplay]=useState<PpgDisplayOptions>(DEFAULT_PPG_DISPLAY);
  const [ecgInfo,setEcgInfo]=useState<EcgInfo|null>(null);
  const ecgScale=useRef(new StableEcgScale());
  const [plotEpoch,setPlotEpoch]=useState(0);
  const currentBoot = useRef(0), connection = useRef(0), isLinked = useRef(false);
  const previousStatus = useRef<Status|null>(null);
  const [activeTab, setActiveTab] = useState('charts');
  const [connected, setConnected] = useState(false), [linkStatus, setLinkStatus] = useState('Disconnected');
  const [deviceStatus, setDeviceStatus] = useState<Status|null>(null), [busy, setBusy] = useState(false);
  const [btError, setBtError] = useState<string|null>(null);
  const [loss, setLoss] = useState(0), [rows, setRows] = useState(0), [recordFull, setRecordFull] = useState(false);
  const [temp, setTemp] = useState<Sample|null>(null), [lastTime, setLastTime] = useState(0);
  const [led, setLed] = useState(31), [windowSeconds, setWindowSeconds] = useState(8);
  const clearPlots = useCallback(() => { waves.current={ecg:[],ppg:[]};trends.current={temperature:[],hrv:[]};hrv.current.reset();spo2.current.reset();ecgDisplay.current=new EcgDisplay(optionsRef.current);ppgFilter.current=new PpgDisplay(ppgOptionsRef.current);ecgScale.current=new StableEcgScale();setPlotEpoch(n=>n+1);setTemp(null);setLastTime(0); }, []);
  useEffect(() => {
    const tx = new TxClient({
      link:(label,on) => {
        if (on&&!isLinked.current) connection.current++;
        isLinked.current=on;setConnected(on);setLinkStatus(label);
        if(on)void gateway.current?.attach();
        if (!on) {gateway.current?.dispose();rxNonce.current=0;setGatewayState(null);setRxState(null);setRxApplied(null);setRxLimits(null);setRxAck('');setRxError(null);hrv.current.reset();spo2.current.reset();setDeviceStatus(null);setEcgInfo(null);setTemp(null);previousStatus.current=null;}
      },
      status:s => {
        if (currentBoot.current!==s.bootId) {clearPlots();currentBoot.current=s.bootId;}
        const old=previousStatus.current;
        if(old&&!old.monitoring&&s.monitoring)clearPlots();
        setLed(draft => !old||(draft===old.red&&draft===old.ir) ? s.red:draft);
        if(old&&(s.red!==old.red||s.ir!==old.ir))spo2.current.reset();
        previousStatus.current=s;setDeviceStatus(s);
        if (!s.monitoring || (s.faults&1)) hrv.current.reset();
        if (!s.monitoring || (s.faults&2)) spo2.current.reset();
        if (!s.monitoring || (s.faults&4)) setTemp(null);
      },
      samples:samples => {
        const captured=samples.map(s=>s.type==='ppg'?{...s,ledRed:previousStatus.current?.red,ledIr:previousStatus.current?.ir}:s);
        recorder.current.add(captured,currentBoot.current,connection.current);
        for (const s of captured) {
          if (s.type==='ecg'||s.type==='ppg') {
            const buffer=waves.current[s.type];buffer.push(s.type==='ecg'?ecgDisplay.current.push(s):ppgFilter.current.push(s));
            const limit=s.type==='ecg'?4096:1600;if(buffer.length>limit)buffer.splice(0,buffer.length-limit);
          } else if (s.type==='temperature') {
            setTemp(s);const points=trends.current.temperature;
            points.push({timeUs:s.timeUs,value:s.valid&&Number.isFinite(s.a)?s.a:null,gap:!!(s.flags&1)});
            if(points.length>600)points.splice(0,points.length-600);
          }
          if(s.type==='ppg')spo2.current.push(s);
          if(s.type==='ecg') {
            const reading=hrv.current.push(s),points=trends.current.hrv;
            if(reading)points.push({timeUs:reading.timeUs,value:reading.rmssdMs});
            else if(points.at(-1)?.value!=null&&hrv.current.reading(s.timeUs).rmssdMs===null)points.push({timeUs:s.timeUs,value:null});
            if(points.length>1200)points.splice(0,points.length-1200);
          }
        }
        if(samples.length)setLastTime(old=>Math.max(old,...samples.map(s=>s.timeUs)));
      },
      error:setBtError,busy:setBusy,loss:setLoss,ecgInfo:setEcgInfo,
    },navigator.bluetooth);
    client.current=tx;
    const gw=new GatewayClient(tx,{link:setGatewayAvailable,error:setRxError,ack:setRxAck,packet:p=>{
      if(p.type==='gateway'){setGatewayState(p.value);if(!(p.value.flags&16)){setRxState(null);setRxApplied(null);rxNonce.current=0;setRxReceivedAt(0);}}
      else if(p.type==='rx'){
        if(rxNonce.current!==p.value.nonce){setRxApplied(null);rxNonce.current=p.value.nonce;}
        setRxState(p.value);setRxReceivedAt(Date.now());
      }else if(p.type==='parameters'&&p.nonce===rxNonce.current)setRxApplied(p.value);
      else if(p.type==='limits')setRxLimits(p.value);
    }});
    gateway.current=gw;
    const hidden=()=>{if(document.hidden){gw.endLease();tx.releasePower();}};
    const leaving=()=>{gw.dispose();tx.dispose();};
    document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',leaving);
    const timer=setInterval(()=>{setRows(recorder.current.rows.length);setRecordFull(recorder.current.full);},250);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',leaving);gw.dispose();gateway.current=null;tx.dispose();client.current=null;};
  },[clearPlots]);
  const ecgSamples=useCallback(()=>waves.current.ecg,[]),ppgSamples=useCallback(()=>waves.current.ppg,[]);
  const temperatureSamples=useCallback(()=>trends.current.temperature,[]),hrvSamples=useCallback(()=>trends.current.hrv,[]);
  const act=(fn:()=>Promise<unknown>|undefined)=>{setBtError(null);void fn()?.catch(e=>setBtError(e instanceof Error?e.message:String(e)));};
  const clear=()=>{recorder.current.clear();setRows(0);setRecordFull(false);clearPlots();};
  const changeDisplay=(value:DisplayOptions)=>{
    optionsRef.current=value;setDisplay(value);const filter=new EcgDisplay(value);
    waves.current.ecg=waves.current.ecg.map(p=>filter.push(p.sample));ecgDisplay.current=filter;setPlotEpoch(n=>n+1);
  };
  const changePpgDisplay=(value:PpgDisplayOptions)=>{
    ppgOptionsRef.current=value;setPpgDisplay(value);const filter=new PpgDisplay(value);
    waves.current.ppg=waves.current.ppg.map(p=>filter.push(p.sample));ppgFilter.current=filter;
  };
  const running=connected&&!!deviceStatus?.monitoring;
  const ecgRaw=waves.current.ecg.map(p=>p.sample),ecgEnd=ecgRaw.at(-1)?.timeUs??0;
  const metrics=ecgMetrics(ecgRaw.filter(s=>s.timeUs>=ecgEnd-windowSeconds*1e6));
  const ecgUnit=display.unit==='mv'&&!ecgRaw.some(s=>s.timeUs>=ecgEnd-windowSeconds*1e6&&s.gain===undefined)?'mV':'Counts';
  const calibration=metrics.source??ecgInfo?.selectedSource??0;
  const tempValid=connected&&measurementFresh(temp,deviceStatus,4,lastTime);
  const estimate=hrv.current.reading(Math.max(lastTime,deviceStatus?.timeUs??0));
  const ecgLive=connected&&!!deviceStatus?.monitoring&&!(deviceStatus.faults&1);
  const uiTemp=tempValid?temp!.a.toFixed(2):'--',uiHr=ecgLive&&estimate.heartRate!==null?estimate.heartRate.toFixed(0):'--';
  const uiHrv=ecgLive&&estimate.rmssdMs!==null?estimate.rmssdMs.toFixed(1):'--';
  const powerOn=connected&&!!deviceStatus?.power;
  const oxygen=spo2.current.reading(Math.max(lastTime,deviceStatus?.timeUs??0));
  const ppgLive=connected&&!!deviceStatus?.monitoring&&!!(deviceStatus.activeSensors&2)&&!(deviceStatus.faults&2);
  const uiSpo2=ppgLive&&oxygen.estimatePct!==null?oxygen.estimatePct.toFixed(1):'--';
  return (
    <div className="flex flex-col h-[100dvh] bg-slate-50 text-slate-900 font-sans overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 bg-white/80 backdrop-blur-md border-b border-slate-200/60 shrink-0 z-10">
        <div className="flex flex-col"><h1 className="font-bold text-lg flex items-center gap-2 tracking-tight"><Activity className="w-5 h-5 text-blue-600"/> VNS TX APP</h1></div>
        <Button disabled={busy&&!connected} variant={connected?'outline':'default'} onClick={()=>connected?client.current?.disconnect():act(()=>client.current?.connect())}
          className={`rounded-full px-4 ${connected?'text-red-600 border-red-200 hover:bg-red-50':'bg-blue-600 hover:bg-blue-700'}`}>
          <Bluetooth className="w-4 h-4 mr-1.5"/>{connected?'Disconnect':'Connect'}
        </Button>
      </header>
      <div className="grid grid-cols-4 gap-1.5 p-2 sm:gap-3 sm:p-3 bg-slate-50 shrink-0 min-w-0" aria-label="Vitals">
        <Vital icon={<Thermometer className="w-3 h-3 shrink-0"/>} label="Temp" value={uiTemp} unit="°C" color="text-slate-800"/>
        <Vital icon={<Droplet className="w-3 h-3 shrink-0"/>} label="SpO2 Est" value={uiSpo2} unit="%" color="text-red-500"/>
        <Vital icon={<HeartPulse className="w-3 h-3 shrink-0"/>} label="HR" value={uiHr} unit="bpm" color="text-blue-500"/>
        <Vital icon={<Activity className="w-3 h-3 shrink-0"/>} label="HRV" value={uiHrv} unit="ms" color="text-violet-500"/>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-2 sm:p-3 flex flex-col">
        {btError&&<div role="alert" className="mb-4 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-2xl text-sm shadow-sm"><strong className="font-bold">Error: </strong>{btError}</div>}
        {activeTab==='charts'&&<div className="grid grid-cols-1 grid-rows-4 md:grid-cols-2 md:grid-rows-2 flex-1 gap-2 sm:gap-3 max-w-6xl mx-auto w-full min-h-[480px]" aria-label="Sensor charts">
          <SignalCard title={calibration?'ECG · INTERNAL CALIBRATION':'ECG'} unit={ecgUnit}><Waveform samples={ecgSamples} kind="ecg" windowSeconds={windowSeconds} epoch={plotEpoch} ecgScale={ecgScale.current} display={display}/></SignalCard>
          <SignalCard title="PPG · IR" unit="Counts"><Waveform samples={ppgSamples} kind="ppg" windowSeconds={windowSeconds}/></SignalCard>
          <SignalCard title="Temperature" unit="°C"><Trend samples={temperatureSamples} windowSeconds={60} color="#d97706" unit="°C"/></SignalCard>
          <SignalCard title="HRV · RMSSD" unit="ms" hint="ECG-derived estimate · rolling 60 s · at least 30 s of clean intervals · not clinically validated"><Trend samples={hrvSamples} windowSeconds={300} color="#0d9488" unit="ms"/></SignalCard>
        </div>}
        {activeTab==='power'&&<div className="space-y-3 max-w-md mx-auto w-full">
          {!!deviceStatus?.faults&&<details role="alert" className="bg-red-50 border border-red-200 text-red-600 px-3 py-2 rounded-xl text-xs"><summary className="cursor-pointer font-semibold">Sensor fault · Power disabled</summary><p className="pt-2">{faultMessage(deviceStatus)}</p></details>}
          {recordFull&&<div role="alert" className="bg-red-50 border border-red-200 text-red-600 px-3 py-2 rounded-xl text-xs">Recording full. Save CSV, then Clear Data.</div>}
          <ControlPanel connected={connected} busy={busy} running={running} rows={rows} windowSeconds={windowSeconds} setWindow={setWindowSeconds}
            led={led} setLed={setLed} appliedRed={deviceStatus?.red} appliedIr={deviceStatus?.ir}
            start={()=>act(()=>client.current?.monitor(true))} stop={()=>act(()=>client.current?.monitor(false))} clear={clear}
            save={()=>saveCsv(recorder.current.rows,{ecg:optionsRef.current,ppg:ppgOptionsRef.current})}
            apply={()=>act(()=>client.current?.configure(led,led))} powerState={connected?deviceStatus?.power??0:null}
            powerAllowed={connected&&!busy&&!powerOn&&!deviceStatus?.faults&&!ecgInfo?.selectedSource&&!(running&&!!calibration)}
            powerOn={()=>act(()=>client.current?.power(true))} powerOff={()=>act(()=>client.current?.power(false))}/>
        </div>}
        {activeTab==='stimulation'&&<StimulationPanel txConnected={connected} available={gatewayAvailable} gateway={gatewayState} rx={rxState} limits={rxLimits} applied={rxApplied} receivedAt={rxReceivedAt} ack={rxAck} error={rxError}
          send={async(op:StimOp,p?:StimParameters)=>{setRxError(null);if(!gateway.current)throw Error('Gateway unavailable');await gateway.current.command(op,p);}}/>}
        {activeTab==='settings'&&<div className="space-y-4 max-w-md mx-auto w-full">
          <EcgControls info={ecgInfo} status={deviceStatus} busy={busy} display={display} setDisplay={changeDisplay} configure={(gain,source)=>act(()=>client.current?.configureEcg(gain,source))} read={()=>act(()=>client.current?.readEcg())}/>
          <PpgControls display={ppgDisplay} setDisplay={changePpgDisplay}/>
          <Card className="rounded-2xl shadow-sm border-slate-200/60 overflow-hidden"><CardContent className="py-4 space-y-4">
            <div className="text-xs text-slate-500">HRV: ECG-derived RMSSD · 60 s window · ≥30 s clean data<br/>Research estimate; not clinically validated.</div>
            <div className="text-xs text-slate-500">SpO2 Est: paired Red/IR · 10 s window<br/>Uncalibrated estimate; not for medical use.</div>
            <details className="text-xs text-slate-500"><summary className="cursor-pointer font-semibold">Advanced Bluetooth & Diagnostics</summary><div className="pt-4 space-y-3">
              <Label>Target Service UUID</Label><Input readOnly value={SERVICE_UUID} className="text-xs font-mono h-10 rounded-lg bg-slate-50 border-slate-200"/>
              <div>{linkStatus} · {rows.toLocaleString()} rows · RX gaps/errors: {loss}</div>
              <Button disabled={!connected||busy} onClick={()=>act(()=>client.current?.refresh())} variant="outline" className="w-full rounded-xl">Refresh Status</Button>
              <div>Actual gain: {ecgInfo?.gain||'--'} V/V · {sourceName(metrics.source??ecgInfo?.source)}</div>
              <div>Raw min/max: {metrics.min??'--'} / {metrics.max??'--'} Counts · p-p: {metrics.vppMv?.toFixed(4)??'--'} mV</div>
              <div>ETAG [0–7]: {ecgInfo?.tags.join(' / ')??'--'} · Clipped: {ecgInfo?.clipped??'--'} · FIFO overflows: {deviceStatus?.ecgOverflows??'--'}</div>
              <div>Dropped samples: {deviceStatus?.droppedSamples??'--'} · TX failures: {deviceStatus?.droppedFrames??'--'}</div>
            </div></details>
          </CardContent></Card>

        </div>}
      </div>
      <nav className="flex-none flex bg-white/90 backdrop-blur-md border-t w-full h-14 shadow-[0_-4px_20px_-5px_rgba(0,0,0,0.05)] z-20 pb-safe" aria-label="Main navigation">
        {[{id:'charts',label:'Monitor',Icon:LineChartIcon},{id:'power',label:'Control',Icon:Zap},{id:'stimulation',label:'Stimulation',Icon:Radio},{id:'settings',label:'Settings',Icon:Settings2}].map(({id,label,Icon})=><button key={id} className={`flex-1 flex flex-col items-center justify-center transition-colors ${activeTab===id?'text-blue-600':'text-slate-400 hover:text-slate-600'}`} onClick={()=>setActiveTab(id)}><Icon className="w-6 h-6 mb-1"/><span className="text-[10px] font-bold tracking-wide uppercase leading-none">{label}</span></button>)}
      </nav>
    </div>
  );
}
function Vital({icon,label,value,unit,color}:{icon:React.ReactNode;label:string;value:string;unit:string;color:string}) {
  return <div className="bg-white px-1 py-2 rounded-2xl shadow-sm border border-slate-100 min-w-0 flex flex-col items-center justify-center"><div className="text-[10px] sm:text-[11px] text-slate-400 font-bold uppercase tracking-wide flex items-center gap-0.5 mb-1">{icon}{label}</div><div className={`font-bold text-lg sm:text-xl whitespace-nowrap ${color}`}>{value}<span className="text-xs sm:text-sm text-slate-400 ml-0.5">{unit}</span></div></div>;
}
function SignalCard({title,unit,hint,children}:{title:string;unit:string;hint?:string;children:React.ReactNode}) {
  return <Card className="flex flex-col min-h-0 rounded-2xl shadow-sm border-slate-200/60 overflow-hidden"><CardHeader className="pb-0 pt-3 px-4"><CardTitle title={hint} className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between gap-2"><span>{title}</span><span className="normal-case font-normal">{unit}</span></CardTitle></CardHeader><CardContent className="flex-1 min-h-0 px-1 pb-1 flex flex-col">{children}</CardContent></Card>;
}
