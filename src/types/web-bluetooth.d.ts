interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications?(): Promise<BluetoothRemoteGATTCharacteristic>;
}
interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristic>;
}
interface BluetoothRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTService>;
}
interface BluetoothDevice extends EventTarget { readonly id: string; readonly name?: string; gatt?: BluetoothRemoteGATTServer; }
interface Bluetooth {
  requestDevice(options: { filters: { services: string[]; namePrefix?: string }[]; optionalServices?: string[] }): Promise<BluetoothDevice>;
  getDevices?(): Promise<BluetoothDevice[]>;
}
interface Navigator { readonly bluetooth?: Bluetooth; }
