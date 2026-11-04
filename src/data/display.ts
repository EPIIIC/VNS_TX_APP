import type { Sample, Status } from '../ble/protocol';

export function measurementFresh(sample:Sample|null,status:Status|null,bit:number,lastDeviceTime=0):boolean {
  return !!sample?.valid && !!status?.monitoring && !!(status.activeSensors&bit) && !(status.faults&bit)
    && Math.max(status.timeUs,lastDeviceTime,sample.timeUs)-sample.timeUs<5e6;
}

export function channelState(status:Status|null,bit:number):string {
  if(!status)return 'Disconnected';
  if(status.faults&bit)return 'Unavailable';
  if(status.monitoring&&(status.activeSensors&bit))return 'Running';
  return status.available&bit?'Ready':'Waiting';
}

export function faultMessage(status:Status):string {
  const names=[[1,'ECG / SPI'],[2,'PPG / I2C'],[4,'Temperature / I2C'],[8,'Watchdog'],[16,'FIFO overflow']] as const;
  const failed=names.filter(([bit])=>status.faults&bit).map(([,name])=>name).join(', ');
  const monitoring=status.capabilities&128
    ? status.monitoring ? status.activeSensors ? 'Available sensors continue recording.' : 'Waiting for sensor recovery.' : 'Start records the available sensors.'
    : 'Update TX firmware to record sensors independently.';
  return `Device fault: ${failed}. Bluetooth remains connected. Power is disabled. ${monitoring}`;
}

/** Invalid ECG is still real raw data, drawn dashed and explicitly labelled.
 * Its validity flag remains false for CSV and heart-rate calculations. */
export function drawableSample(sample:Sample,kind:'ecg'|'ppg'):boolean {
  return sample.valid || (kind==='ecg' && sample.type==='ecg' && sample.tag!==undefined && sample.tag<=3);
}
