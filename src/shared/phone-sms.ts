export interface PhoneSms {
  event: "sms:received";
  messageId: string;
  sender: string;
  message: string;
  receivedAt: number;
  simNumber: number | null;
}

export interface PhoneSmsEntry extends PhoneSms {
  deviceName: string;
}
